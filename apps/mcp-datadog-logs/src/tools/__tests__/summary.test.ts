import type { ComparisonResult } from '@kajidog/investigation-shared'
import { VIEW_UUID_PATTERN } from '@kajidog/investigation-shared'
import { describe, expect, it } from 'vitest'
import { formatInvestigationSummary } from '../investigate/summary.js'
import { fixtureResult, fixtureRow } from './fixtures.js'

const VIEW_UUID = '11111111-2222-3333-4444-555555555555'

function fixtureComparison(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    params: { query: 'service:payments status:error', mode: 'shift', shift: '1d', facets: ['service'] },
    target: {
      fromMs: Date.parse('2026-07-06T09:10:00Z'),
      toMs: Date.parse('2026-07-06T10:10:00Z'),
      totalCount: 1234,
      statusCounts: { error: 120, info: 1114 },
      errorRate: 0.0972,
    },
    baseline: {
      fromMs: Date.parse('2026-07-05T09:10:00Z'),
      toMs: Date.parse('2026-07-05T10:10:00Z'),
      totalCount: 600,
      statusCounts: { error: 12, info: 588 },
      errorRate: 0.02,
    },
    interval: '5m',
    volume: {
      total: { targetCount: 1234, baselineCount: 600, delta: 634, ratio: 2.06 },
      byStatus: [{ status: 'error', targetCount: 120, baselineCount: 12, delta: 108, ratio: 10 }],
      errorRateDelta: 0.0772,
    },
    fetchedAt: '2026-07-06T10:10:00.000Z',
    ...overrides,
  }
}

describe('formatInvestigationSummary', () => {
  it('starts with the viewUUID contract line', () => {
    const summary = formatInvestigationSummary(fixtureResult(), VIEW_UUID)
    const [first] = summary.split('\n')
    const match = first.match(new RegExp(VIEW_UUID_PATTERN))
    expect(match?.[1]).toBe(VIEW_UUID)
  })

  it('includes totals, status counts and top facet values', () => {
    const summary = formatInvestigationSummary(fixtureResult(), VIEW_UUID)
    expect(summary).toContain('Query: service:payments status:error | Range: now-1h → now')
    expect(summary).toContain('Total: ~1,234 logs — error: 120, warn: 90, info: 980')
    expect(summary).toContain('service: payments (400), checkout (330), auth (260) +1 more, (other) 42')
    expect(summary).toContain('host: i-0a1b2c (500)')
  })

  it('inlines sample rows with collapsed whitespace and honors sampleRows: 0', () => {
    const result = fixtureResult({
      rows: [fixtureRow('log-1', { message: 'line one\n  line two\ttabbed' }), fixtureRow('log-2')],
    })
    const withSamples = formatInvestigationSummary(result, VIEW_UUID, { sampleRows: 1 })
    expect(withSamples).toContain('Sample logs (1 of 2 stored, errors first):')
    expect(withSamples).toContain('line one line two tabbed')
    expect(withSamples).not.toContain('log-2)')

    const noSamples = formatInvestigationSummary(result, VIEW_UUID, { sampleRows: 0 })
    expect(noSamples).not.toContain('Sample logs')
    expect(noSamples).toContain('2 log rows stored in the session.')
  })

  it('picks error rows first and prefixes samples with their absolute row index', () => {
    const result = fixtureResult({
      rows: [
        fixtureRow('log-1', { status: 'info', message: 'info row' }),
        fixtureRow('log-2', { status: 'warn', message: 'warn row' }),
        fixtureRow('log-3', { status: 'error', message: 'error row' }),
      ],
    })
    const summary = formatInvestigationSummary(result, VIEW_UUID, { sampleRows: 2 })
    const lines = summary.split('\n')
    const sampleStart = lines.findIndex((line) => line.startsWith('Sample logs'))
    expect(lines[sampleStart + 1]).toContain('[2]')
    expect(lines[sampleStart + 1]).toContain('error row')
    expect(lines[sampleStart + 2]).toContain('[1]')
    expect(lines[sampleStart + 2]).toContain('warn row')
  })

  it('truncates long sample messages', () => {
    const result = fixtureResult({ rows: [fixtureRow('log-1', { message: 'x'.repeat(400) })] })
    const summary = formatInvestigationSummary(result, VIEW_UUID, { sampleRows: 1 })
    expect(summary).toContain(`${'x'.repeat(200)}…`)
    expect(summary).not.toContain('x'.repeat(201))
  })

  it('lists top patterns without rowIds and honors topPatterns: 0', () => {
    const result = fixtureResult({
      patterns: [
        {
          template: 'Payment failed for <*>',
          count: 3,
          ratio: 0.75,
          example: 'Payment failed for A',
          rowIds: ['log-1'],
        },
        { template: `Cache ${'y'.repeat(200)}`, count: 1, ratio: 0.25, example: 'Cache …', rowIds: ['log-4'] },
      ],
    })
    const summary = formatInvestigationSummary(result, VIEW_UUID, { topPatterns: 5 })
    expect(summary).toContain('Top patterns (of 4 fetched rows):')
    expect(summary).toContain('#1 3 (75%) Payment failed for <*>')
    expect(summary).toContain(`#2 1 (25%) Cache ${'y'.repeat(114)}…`)
    expect(summary).not.toContain('rowIds')
    expect(summary).not.toContain('y'.repeat(115))

    const capped = formatInvestigationSummary(result, VIEW_UUID, { topPatterns: 1 })
    expect(capped).toContain('Top patterns (of 4 fetched rows) +1 more:')
    expect(capped).not.toContain('Cache')

    expect(formatInvestigationSummary(result, VIEW_UUID, { topPatterns: 0 })).not.toContain('Top patterns')
    expect(formatInvestigationSummary(fixtureResult(), VIEW_UUID)).not.toContain('Top patterns')
  })

  it('appends nextCursor only when present', () => {
    expect(formatInvestigationSummary(fixtureResult(), VIEW_UUID)).not.toContain('nextCursor:')
    expect(formatInvestigationSummary(fixtureResult({ nextCursor: 'abc123' }), VIEW_UUID)).toContain(
      'nextCursor: abc123'
    )
  })

  it('lists events chronologically and flags those near the error spike', () => {
    const result = fixtureResult({
      timeline: [
        { time: '2026-07-06T10:00:00.000Z', counts: { error: 2 } },
        { time: '2026-07-06T10:05:00.000Z', counts: { error: 50 } },
        { time: '2026-07-06T10:10:00.000Z', counts: { error: 3 } },
      ],
      events: [
        { id: 'e1', time: '2026-07-06T10:06:00.000Z', kind: 'deploy', title: 'Deploy v2', source: 'github' },
        { id: 'e2', time: '2026-07-06T10:40:00.000Z', kind: 'other', title: 'Unrelated event' },
      ],
    })
    const summary = formatInvestigationSummary(result, VIEW_UUID)
    expect(summary).toContain('Events in window (2):')
    expect(summary).toContain('2026-07-06T10:06:00.000Z [deploy] github — Deploy v2 (near error spike)')
    expect(summary).toContain('2026-07-06T10:40:00.000Z [other] Unrelated event')
    expect(summary).not.toContain('Unrelated event (near error spike)')
  })

  it('lists one stats line per metric series', () => {
    const result = fixtureResult({
      metrics: [
        {
          query: 'avg:system.cpu.user{*}',
          metric: 'avg:system.cpu.user',
          scope: 'service:payments',
          unit: '%',
          points: [{ time: '2026-07-06T10:00:00.000Z', value: 45.6 }],
          stats: { min: 12.3, max: 98.7, avg: 45.6, last: 50.1 },
        },
      ],
    })
    const summary = formatInvestigationSummary(result, VIEW_UUID)
    expect(summary).toContain('Metrics:')
    expect(summary).toContain('avg:system.cpu.user service:payments [%] min 12.3 avg 45.6 max 98.7 last 50.1')
  })

  it('lists trace candidates with a ready-to-use pivot', () => {
    const result = fixtureResult({
      traceCandidates: [
        {
          traceId: 'abc123',
          count: 5,
          errorCount: 4,
          firstSeen: '2026-07-06T10:01:00.000Z',
          services: ['payments', 'checkout'],
        },
      ],
    })
    const summary = formatInvestigationSummary(result, VIEW_UUID)
    expect(summary).toContain('Trace candidates (from stored rows):')
    expect(summary).toContain(
      'abc123 — 5 rows (4 errors) services=payments,checkout → datadog_get_trace trace_id=abc123'
    )
  })

  it('prefixes notices with Note:', () => {
    const summary = formatInvestigationSummary(fixtureResult({ notices: ['Events unavailable: 403'] }), VIEW_UUID)
    expect(summary).toContain('Note: Events unavailable: 403')
  })

  it('splices the comparison in without its header line', () => {
    const summary = formatInvestigationSummary(fixtureResult({ comparison: fixtureComparison() }), VIEW_UUID)
    expect(summary).toContain('Volume: 1,234 vs 600 (+634, 2.06x)')
    expect(summary).toContain('Error rate: 9.7% vs 2.0% (+7.7 pts)')
    expect(summary).toContain('error 120 vs 12 (+108, 10.0x)')
    // compact mode: the query and range are already on the summary's own lines.
    expect(summary).not.toContain('Comparison: ')
  })

  it('renders comparison notices and attribution when present', () => {
    const comparison = fixtureComparison({
      facets: [
        {
          facet: 'service',
          values: [
            {
              value: 'payments',
              targetCount: 900,
              baselineCount: 100,
              targetShare: 0.73,
              baselineShare: 0.17,
              excess: 694,
              lift: 4.3,
            },
          ],
          targetCovered: 1234,
          baselineCovered: 600,
          targetTotal: 1234,
          baselineTotal: 600,
        },
      ],
      notices: ['The baseline window holds only 600 logs.'],
    })
    const summary = formatInvestigationSummary(fixtureResult({ comparison }), VIEW_UUID)
    expect(summary).toContain('service attribution')
    expect(summary).toContain('payments 900 vs 100')
    expect(summary).toContain('Note: The baseline window holds only 600 logs.')
  })

  it('produces byte-identical output for results without cross-source fields', () => {
    const legacy = fixtureResult()
    const summary = formatInvestigationSummary(legacy, VIEW_UUID)
    expect(summary).not.toContain('Events in window')
    expect(summary).not.toContain('Metrics:')
    expect(summary).not.toContain('Trace candidates')
    expect(summary).not.toContain('Note:')
    // Explicitly-empty arrays must render the same as absent fields.
    const withEmpty = fixtureResult({ events: [], metrics: [], traceCandidates: [], notices: [] })
    expect(formatInvestigationSummary(withEmpty, VIEW_UUID)).toBe(summary)
  })
})
