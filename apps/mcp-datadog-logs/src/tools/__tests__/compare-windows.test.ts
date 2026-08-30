import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComparisonResult, OnsetDetection } from '@kajidog/investigation-shared'
import { VIEW_UUID_PATTERN } from '@kajidog/investigation-shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runComparison } from '../../datadog/comparison.js'
import { createServer } from '../../server.js'
import { formatComparisonLines, formatComparisonSummary } from '../comparison-summary.js'
import { clearSessions, getSession, setSession } from '../investigate/runtime.js'
import { fixtureRawById, fixtureResult } from './fixtures.js'

vi.mock('../../datadog/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../datadog/client.js')>()),
  getDatadogClient: vi.fn(() => ({})),
}))
vi.mock('../../datadog/comparison.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../datadog/comparison.js')>()),
  runComparison: vi.fn(),
}))

const runComparisonMock = vi.mocked(runComparison)
const VIEW_UUID = '11111111-2222-3333-4444-555555555555'
const TARGET_FROM = Date.parse('2026-08-24T09:00:00Z')
const TARGET_TO = Date.parse('2026-08-24T10:00:00Z')

function fixtureComparison(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    params: { query: 'service:payments', scope: 'status:error', mode: 'previous', facets: ['service'] },
    target: {
      fromMs: TARGET_FROM,
      toMs: TARGET_TO,
      totalCount: 4120,
      statusCounts: { error: 980, info: 3140 },
      errorRate: 980 / 4120,
    },
    baseline: {
      fromMs: TARGET_FROM - 3_600_000,
      toMs: TARGET_FROM,
      totalCount: 1180,
      statusCounts: { error: 41, info: 1139 },
      errorRate: 41 / 1180,
    },
    interval: '1m',
    volume: {
      total: { targetCount: 4120, baselineCount: 1180, delta: 2940, ratio: 4120 / 1180 },
      byStatus: [
        { status: 'error', targetCount: 980, baselineCount: 41, delta: 939, ratio: 980 / 41 },
        { status: 'info', targetCount: 3140, baselineCount: 1139, delta: 2001, ratio: 3140 / 1139 },
      ],
      errorRateDelta: 980 / 4120 - 41 / 1180,
    },
    fetchedAt: '2026-08-24T10:00:05.000Z',
    ...overrides,
  }
}

function fixtureOnset(): OnsetDetection {
  return {
    time: '2026-08-24T09:20:00.000Z',
    bucketIndex: 20,
    errorRate: 0.194,
    baselineMean: 0.031,
    baselineStdev: 0.012,
    threshold: 0.067,
    sustainedBuckets: 6,
    sigmas: 13.58,
    precedingEvent: {
      event: {
        id: 'evt-1',
        time: '2026-08-24T09:12:00.000Z',
        kind: 'deploy',
        title: 'Deploy payments v2.4.1',
        source: 'github',
      },
      leadTimeMs: 8 * 60_000,
    },
    nearbyEvents: [
      {
        event: { id: 'evt-2', time: '2026-08-24T09:21:00.000Z', kind: 'alert', title: 'Monitor triggered' },
        leadTimeMs: -60_000,
      },
    ],
  }
}

function getHandler(name: string) {
  const server = createServer()
  const tools = (server as any)._registeredTools as Record<string, { handler: (args: any, extra: any) => any }>
  return (args: Record<string, unknown>) => tools[name].handler(args, {})
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    query: 'service:payments',
    from: 'now-1h',
    to: 'now',
    scope: 'status:error',
    sample_limit: 200,
    include_events: true,
    include_patterns: true,
    ...overrides,
  }
}

function resultText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? '').join('\n')
}

describe('formatComparisonSummary', () => {
  it('renders the header, volume and per-status deltas', () => {
    const text = formatComparisonSummary(fixtureComparison())

    expect(text.split('\n')[0]).toBe(
      'Comparison: service:payments (scope status:error) | target 2026-08-24T09:00Z→2026-08-24T10:00Z ' +
        'vs baseline (previous) 2026-08-24T08:00Z→2026-08-24T09:00Z | buckets 1m'
    )
    expect(text).toContain('Volume: 4,120 vs 1,180 (+2,940, 3.49x)')
    expect(text).toContain('error 980 vs 41 (+939, 23.9x)')
    expect(text).toContain('info 3,140 vs 1,139 (+2,001, 2.76x)')
  })

  it('names the shift when the baseline was derived by shifting', () => {
    const text = formatComparisonSummary(
      fixtureComparison({
        params: { query: '*', mode: 'shift', shift: '1d', facets: [] },
      })
    )

    expect(text).toContain('vs baseline (shift 1d)')
    expect(text).not.toContain('(scope')
  })

  it('omits the header line in compact mode but keeps the numbers', () => {
    const text = formatComparisonSummary(fixtureComparison(), { compact: true })

    expect(text).not.toContain('Comparison:')
    expect(text.split('\n')[0]).toContain('Volume: 4,120 vs 1,180')
  })

  it('always shows the error-rate line, including when the rate barely moved', () => {
    expect(formatComparisonSummary(fixtureComparison())).toContain('Error rate: 23.8% vs 3.5% (+20.3 pts)')

    const flat = formatComparisonSummary(
      fixtureComparison({
        target: {
          fromMs: TARGET_FROM,
          toMs: TARGET_TO,
          totalCount: 4120,
          statusCounts: { error: 124, info: 3996 },
          errorRate: 0.03,
        },
        volume: {
          total: { targetCount: 4120, baselineCount: 1180, delta: 2940, ratio: 4120 / 1180 },
          byStatus: [],
          errorRateDelta: 0.03 - 41 / 1180,
        },
      })
    )
    expect(flat).toContain('Error rate: 3.0% vs 3.5% (-0.5 pts)')
  })

  it('spells out a null ratio instead of leaking Infinity, NaN, null or undefined', () => {
    const text = formatComparisonSummary(
      fixtureComparison({
        baseline: { fromMs: TARGET_FROM - 3_600_000, toMs: TARGET_FROM, totalCount: 0, statusCounts: {}, errorRate: 0 },
        volume: {
          total: { targetCount: 4120, baselineCount: 0, delta: 4120, ratio: null },
          byStatus: [{ status: 'error', targetCount: 980, baselineCount: 0, delta: 980, ratio: null }],
          errorRateDelta: 980 / 4120,
        },
        patterns: [
          {
            template: 'Connection pool exhausted for <*>',
            kind: 'spiking',
            targetRatio: 0.148,
            baselineRatio: 0,
            targetSampleCount: 30,
            baselineSampleCount: 0,
            estimatedTargetCount: 610,
            estimatedBaselineCount: 0,
            lift: null,
            example: 'Connection pool exhausted for db-main',
          },
        ],
        facets: [
          {
            facet: 'service',
            values: [
              {
                value: 'payments',
                targetCount: 840,
                baselineCount: 0,
                targetShare: 0.857,
                baselineShare: 0,
                excess: 840,
                lift: null,
                isNew: true,
              },
            ],
            targetCovered: 980,
            baselineCovered: 0,
            targetTotal: 4120,
            baselineTotal: 0,
          },
        ],
        onset: { ...fixtureOnset(), sigmas: null },
      })
    )

    expect(text).not.toMatch(/Infinity|NaN|null|undefined/)
    expect(text).toContain('new (baseline 0)')
    expect(text).not.toContain('σ')
  })

  it('renders pattern diffs with truncated templates', () => {
    const text = formatComparisonSummary(
      fixtureComparison({
        patterns: [
          {
            template: `Payment failed: upstream timeout after <*> ${'x'.repeat(200)}`,
            kind: 'spiking',
            targetRatio: 0.19,
            baselineRatio: 0.011,
            targetSampleCount: 38,
            baselineSampleCount: 2,
            estimatedTargetCount: 380,
            estimatedBaselineCount: 22,
            lift: 17.27,
            example: 'Payment failed: upstream timeout after 30s',
          },
          {
            template: 'Retrying connection to redis (attempt <*>)',
            kind: 'gone',
            targetRatio: 0,
            baselineRatio: 0.015,
            targetSampleCount: 0,
            baselineSampleCount: 3,
            estimatedTargetCount: 0,
            estimatedBaselineCount: 18,
            lift: 0,
            example: 'Retrying connection to redis (attempt 3)',
          },
        ],
      })
    )

    expect(text).toContain('Patterns (window counts extrapolated from the sampled rows):')
    expect(text).toContain('SPIKING  ~380 vs ~22 (17.3x) Payment failed: upstream timeout after <*>')
    expect(text).toContain(
      'GONE     ~0 vs ~18 (1.5% of the baseline sample) Retrying connection to redis (attempt <*>)'
    )
    expect(text).not.toContain('x'.repeat(120))
  })

  it('renders facet attribution and never labels a truncated baseline value NEW', () => {
    const text = formatComparisonSummary(
      fixtureComparison({
        facets: [
          {
            facet: 'service',
            values: [
              {
                value: 'payments',
                targetCount: 840,
                baselineCount: 12,
                targetShare: 0.857,
                baselineShare: 0.293,
                excess: 798.4,
                lift: 2.92,
                isNew: false,
              },
              {
                value: 'ledger',
                targetCount: 90,
                baselineCount: 0,
                targetShare: 0.092,
                baselineShare: 0,
                excess: 90,
                lift: null,
                baselineTruncated: true,
              },
              {
                value: 'checkout',
                targetCount: 50,
                baselineCount: 0,
                targetShare: 0.051,
                baselineShare: 0,
                excess: 50,
                lift: null,
                isNew: true,
              },
            ],
            targetCovered: 980,
            baselineCovered: 41,
            targetTotal: 4120,
            baselineTotal: 1180,
          },
        ],
      })
    )

    expect(text).toContain('service attribution (excess = beyond a uniform 23.9x scale-up):')
    expect(text).toContain('payments 840 vs 12 (+798 excess, share 85.7% vs 29.3%)')
    expect(text).toContain('ledger 90 vs 0 (+90 excess, share 9.2% vs 0.0%) rare in baseline')
    expect(text).toContain('checkout 50 vs 0 (+50 excess, share 5.1% vs 0.0%) NEW')

    const ledgerLine = text.split('\n').find((line) => line.includes('ledger')) ?? ''
    expect(ledgerLine).not.toContain('NEW')
  })

  it('renders the onset with its bucket position and correlated events', () => {
    const text = formatComparisonSummary(fixtureComparison({ onset: fixtureOnset() }))

    expect(text).toContain(
      'Onset: 2026-08-24T09:20:00.000Z (bucket 21/60, rate 19.4% vs baseline mean 3.1% ±1.2%, ' +
        'threshold 6.7%, 13.6σ, sustained 6 buckets)'
    )
    expect(text).toContain(
      '  preceded by 2026-08-24T09:12:00.000Z [deploy] github — Deploy payments v2.4.1 (8m before onset)'
    )
    expect(text).toContain('  nearby: 2026-08-24T09:21:00.000Z [alert] Monitor triggered (1m after onset)')
  })

  it('prints no section headers when patterns, facets, onset and notices are absent', () => {
    const text = formatComparisonSummary(fixtureComparison())

    expect(text).not.toContain('Patterns')
    expect(text).not.toContain('attribution')
    expect(text).not.toContain('Onset:')
    expect(text).not.toContain('Note:')
    expect(text.split('\n')).toHaveLength(3)
  })

  it('renders empty arrays exactly like absent fields', () => {
    expect(formatComparisonSummary(fixtureComparison({ patterns: [], facets: [], notices: [] }))).toBe(
      formatComparisonSummary(fixtureComparison())
    )
  })

  it('renders every notice on its own line', () => {
    const text = formatComparisonSummary(
      fixtureComparison({ notices: ['The baseline window overlaps the target window.', 'Events unavailable.'] })
    )

    expect(text).toContain('Note: The baseline window overlaps the target window.')
    expect(text).toContain('Note: Events unavailable.')
  })

  it('formatComparisonLines returns the lines the string form joins', () => {
    const result = fixtureComparison({ onset: fixtureOnset(), notices: ['A notice.'] })
    const lines = formatComparisonLines(result)

    expect(lines.join('\n')).toBe(formatComparisonSummary(result))
    expect(formatComparisonLines(result, { compact: true })).toEqual(lines.slice(1))
  })
})

describe('datadog_compare_windows', () => {
  beforeEach(() => {
    clearSessions()
    runComparisonMock.mockReset()
    runComparisonMock.mockResolvedValue(fixtureComparison())
    vi.unstubAllEnvs()
    vi.stubEnv('MCP_DATADOG_SESSION_DIR', mkdtempSync(join(tmpdir(), 'dd-compare-')))
  })

  function seedSession(): void {
    const result = fixtureResult()
    setSession(VIEW_UUID, {
      result,
      rawById: fixtureRawById(result),
      title: 'Seeded',
      createdAt: 1,
      updatedAt: 1,
    })
  }

  it('forwards the parameters and defaults the facets to service', async () => {
    await getHandler('datadog_compare_windows')(baseArgs({ baseline: '1d' }))

    expect(runComparisonMock).toHaveBeenCalledTimes(1)
    const options = runComparisonMock.mock.calls[0][1]
    expect(options).toMatchObject({
      query: 'service:payments',
      from: 'now-1h',
      to: 'now',
      baseline: '1d',
      scope: 'status:error',
      facets: ['service'],
      sampleLimit: 200,
      includeEvents: true,
      includePatterns: true,
    })
    expect('baselineFrom' in options).toBe(false)
    expect('baselineTo' in options).toBe(false)
    expect('precomputedTarget' in options).toBe(false)
  })

  it('normalizes a comma-separated facets string and caps it at three', async () => {
    await getHandler('datadog_compare_windows')(baseArgs({ facets: 'service, host ,env, extra' }))

    expect(runComparisonMock.mock.calls[0][1].facets).toEqual(['service', 'host', 'env'])
  })

  it('returns the comparison without a viewUUID line when none was supplied', async () => {
    const text = resultText(await getHandler('datadog_compare_windows')(baseArgs()))

    expect(text).not.toMatch(/viewUUID:/)
    expect(text.split('\n')[0]).toContain('Comparison: service:payments')
  })

  it('attaches the comparison to an existing session and puts viewUUID on line one', async () => {
    seedSession()

    const text = resultText(await getHandler('datadog_compare_windows')(baseArgs({ viewUUID: VIEW_UUID })))

    expect(text.split('\n')[0].match(new RegExp(VIEW_UUID_PATTERN))?.[1]).toBe(VIEW_UUID)
    expect(text).toContain('Volume: 4,120 vs 1,180')
    expect(getSession(VIEW_UUID)?.result.comparison?.volume.total.targetCount).toBe(4120)
  })

  it('still returns the comparison when the session is missing, without claiming a view', async () => {
    const text = resultText(await getHandler('datadog_compare_windows')(baseArgs({ viewUUID: VIEW_UUID })))

    expect(text).not.toMatch(/viewUUID:/)
    expect(text).toContain('was not found')
    expect(text).toContain('not attached')
    expect(text).toContain('Volume: 4,120 vs 1,180')
  })

  it('reports a failed comparison as a tool error', async () => {
    runComparisonMock.mockRejectedValue(new Error('window totals unavailable'))

    const result = await getHandler('datadog_compare_windows')(baseArgs())

    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('window totals unavailable')
  })
})
