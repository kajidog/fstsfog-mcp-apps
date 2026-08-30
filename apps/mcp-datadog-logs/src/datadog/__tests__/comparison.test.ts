import type { FacetBreakdown, TimelineBucket } from '@kajidog/investigation-shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatadogLogsClient } from '../client.js'
import type { PrecomputedTargetWindow, RunComparisonOptions } from '../comparison.js'
import { runComparison, scopedQuery } from '../comparison.js'
import type { RawAggregateBucket, RawLog } from '../normalize.js'

const NOW_MS = Date.parse('2026-07-14T10:00:00.000Z')
const TARGET_FROM = '2026-07-14T09:00:00.000Z'
const TARGET_TO = '2026-07-14T10:00:00.000Z'
const BASELINE_FROM = '2026-07-14T08:00:00.000Z'
const BASELINE_TO = '2026-07-14T09:00:00.000Z'
/** pickInterval(1h) — asserted rather than hardcoded blindly by the tests below. */
const INTERVAL = '1m'

function countBuckets(facet: string, counts: Record<string, number>): RawAggregateBucket[] {
  return Object.entries(counts).map(([value, count]) => ({ by: { [facet]: value }, computes: { c0: count } }))
}

function timeseries(startIso: string, series: Record<string, number[]>): RawAggregateBucket[] {
  const start = Date.parse(startIso)
  return Object.entries(series).map(([status, values]) => ({
    by: { status },
    computes: { c0: values.map((value, index) => ({ time: new Date(start + index * 60_000).toISOString(), value })) },
  }))
}

const flat = (value: number, length = 10) => Array.from({ length }, () => value)
/** Steady until bucket 5, then a sustained error-rate jump — a detectable onset. */
const RISING_ERRORS = [1, 1, 1, 1, 1, 50, 50, 50, 50, 50]

function rawLog(id: string, message: string): RawLog {
  return {
    id,
    attributes: { timestamp: '2026-07-14T09:30:00.000Z', status: 'error', service: 'payments', message },
  }
}

const targetLogs = (count = 3) =>
  Array.from({ length: count }, (_, i) => rawLog(`t${i}`, `timeout connecting to db shard ${i}`))
const baselineLogs = (count = 3) => Array.from({ length: count }, (_, i) => rawLog(`b${i}`, `user ${i} logged in`))

function windowOf(from: string): 'target' | 'baseline' {
  return from === TARGET_FROM ? 'target' : 'baseline'
}

/** Union of the client parameter shapes the fake dispatches on. */
interface CallParams {
  from: string
  to: string
  query: string
  facet?: string
  interval?: string
  limit?: number
}

/**
 * Records every call as "name[:facet]@window" so a test can assert the exact
 * sequence, and tracks overlap so a Promise.all regression fails loudly.
 */
function fakeClient() {
  const calls: string[] = []
  let inFlight = 0
  let maxInFlight = 0

  const track = <R>(name: (params: CallParams) => string, handler: (params: CallParams) => R) =>
    vi.fn(async (params: CallParams) => {
      calls.push(`${name(params)}@${windowOf(params.from)}`)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      await Promise.resolve()
      inFlight -= 1
      return handler(params)
    })

  const statusCounts: Record<string, Record<string, number>> = {
    target: { error: 30, info: 70 },
    baseline: { error: 10, info: 190 },
  }
  const serviceCounts: Record<string, Record<string, number>> = {
    target: { payments: 60, web: 40 },
    baseline: { payments: 100, web: 100 },
  }

  return {
    calls,
    maxInFlight: () => maxInFlight,
    aggregateByFacet: track(
      (params) => `facet:${params.facet}`,
      (params) => {
        const side = windowOf(params.from)
        if (params.facet === 'status') {
          return countBuckets('status', statusCounts[side])
        }
        if (params.facet === 'service') {
          return countBuckets('service', serviceCounts[side])
        }
        return countBuckets(params.facet ?? 'unknown', { alpha: 5 })
      }
    ),
    aggregateTimeseriesByStatus: track(
      () => 'timeline',
      (params) =>
        windowOf(params.from) === 'target'
          ? timeseries(TARGET_FROM, { info: flat(100), error: RISING_ERRORS })
          : timeseries(BASELINE_FROM, { info: flat(100), error: flat(1) })
    ),
    searchLogs: track(
      () => 'search',
      (params) => ({ logs: windowOf(params.from) === 'target' ? targetLogs() : baselineLogs() })
    ),
    searchEvents: track(
      () => 'events',
      () => [
        {
          id: 'e1',
          attributes: {
            timestamp: '2026-07-14T09:04:00.000Z',
            attributes: { title: 'Deploy payments v9', sourceTypeName: 'github' },
          },
        },
      ]
    ),
  }
}

type FakeClient = ReturnType<typeof fakeClient>

const DEFAULT_ORDER = [
  'facet:status@target',
  'timeline@target',
  'facet:service@target',
  'search@target',
  'events@target',
  'facet:status@baseline',
  'timeline@baseline',
  'facet:service@baseline',
  'search@baseline',
]

describe('scopedQuery', () => {
  it('falls back to * for an empty query with no scope', () => {
    expect(scopedQuery('', undefined)).toBe('*')
    expect(scopedQuery('   ', '')).toBe('*')
  })

  it('returns the scope alone when the query matches everything', () => {
    expect(scopedQuery('*', 'status:error')).toBe('status:error')
    expect(scopedQuery('', 'status:error')).toBe('status:error')
  })

  it('parenthesizes a real query before appending the scope', () => {
    expect(scopedQuery('service:web OR service:api', 'status:error')).toBe('(service:web OR service:api) status:error')
  })

  it('returns the bare query when the scope is empty', () => {
    expect(scopedQuery('service:web', '')).toBe('service:web')
    expect(scopedQuery('service:web', undefined)).toBe('service:web')
  })
})

describe('runComparison', () => {
  let client: FakeClient

  beforeEach(() => {
    client = fakeClient()
  })

  const run = (options: Partial<RunComparisonOptions> = {}) =>
    runComparison(client as unknown as DatadogLogsClient, {
      query: '*',
      from: 'now-1h',
      to: 'now',
      nowMs: NOW_MS,
      ...options,
    })

  const callCount = () => client.calls.length

  it('issues 9 sequential calls in target-then-baseline order by default', async () => {
    await run()
    expect(client.calls).toEqual(DEFAULT_ORDER)
    expect(callCount()).toBe(9)
    expect(client.maxInFlight()).toBe(1)
  })

  it('issues only the 4 aggregation calls when facets, patterns and events are all off', async () => {
    await run({ facets: [], includePatterns: false, includeEvents: false })
    expect(client.calls).toEqual([
      'facet:status@target',
      'timeline@target',
      'facet:status@baseline',
      'timeline@baseline',
    ])
    expect(callCount()).toBe(4)
    expect(client.maxInFlight()).toBe(1)
  })

  it('issues 13 calls with the maximum of 3 facets, and caps the facet list at 3', async () => {
    const result = await run({ facets: ['service', 'host', '@http.status_code', 'env'] })
    expect(result.params.facets).toEqual(['service', 'host', '@http.status_code'])
    expect(callCount()).toBe(13)
    expect(client.maxInFlight()).toBe(1)
  })

  it('fetches facet values with the raised 100-value cap, and window totals from the status aggregation', async () => {
    const result = await run()
    expect(client.aggregateByFacet).toHaveBeenCalledWith(expect.objectContaining({ facet: 'service', limit: 100 }))
    expect(client.aggregateByFacet).toHaveBeenCalledWith(expect.objectContaining({ facet: 'status', limit: 20 }))
    expect(result.target.totalCount).toBe(100)
    expect(result.baseline.totalCount).toBe(200)
    expect(result.facets?.[0]).toMatchObject({ facet: 'service', targetTotal: 100, baselineTotal: 200 })
  })

  it('scopes only the pattern sample, leaving the aggregations on the bare query', async () => {
    await run({ query: 'service:web' })
    expect(client.searchLogs).toHaveBeenCalledWith(
      expect.objectContaining({ query: '(service:web) status:error', limit: 200, sort: '-timestamp' })
    )
    expect(client.aggregateByFacet).toHaveBeenCalledWith(expect.objectContaining({ query: 'service:web' }))
  })

  it("honours scope: '' by sampling on the bare query", async () => {
    const result = await run({ query: 'service:web', scope: '' })
    expect(client.searchLogs).toHaveBeenCalledWith(expect.objectContaining({ query: 'service:web' }))
    expect('scope' in result.params).toBe(false)
  })

  it('sends both windows the same interval', async () => {
    const result = await run()
    expect(result.interval).toBe(INTERVAL)
    for (const call of client.aggregateTimeseriesByStatus.mock.calls) {
      expect(call[0].interval).toBe(INTERVAL)
    }
    expect(client.aggregateTimeseriesByStatus).toHaveBeenCalledTimes(2)
  })

  it('sends absolute ISO instants, never the relative range it was given', async () => {
    await run()
    const bounds = [
      ...client.aggregateByFacet.mock.calls,
      ...client.aggregateTimeseriesByStatus.mock.calls,
      ...client.searchLogs.mock.calls,
      ...client.searchEvents.mock.calls,
    ].map((call) => call[0] as { from: string; to: string })
    expect(bounds.length).toBe(9)
    for (const { from, to } of bounds) {
      expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    expect(bounds.filter((b) => b.from === TARGET_FROM && b.to === TARGET_TO)).toHaveLength(5)
    expect(bounds.filter((b) => b.from === BASELINE_FROM && b.to === BASELINE_TO)).toHaveLength(4)
  })

  it('echoes the resolved baseline mode and shift', async () => {
    const previous = await run()
    expect(previous.params.mode).toBe('previous')
    expect('shift' in previous.params).toBe(false)

    client = fakeClient()
    const shifted = await run({ baseline: 'yesterday' })
    expect(shifted.params).toMatchObject({ mode: 'shift', shift: '1d' })

    client = fakeClient()
    const custom = await run({ baselineFrom: '2026-07-10T09:00:00Z', baselineTo: '2026-07-10T10:00:00Z' })
    expect(custom.params.mode).toBe('custom')
  })

  it('produces volume, patterns, facets and an event-correlated onset', async () => {
    const result = await run()
    expect(result.volume.total).toMatchObject({ targetCount: 100, baselineCount: 200, delta: -100, ratio: 0.5 })
    expect(result.volume.errorRateDelta).toBeCloseTo(0.3 - 0.05, 10)
    expect(result.patterns?.some((diff) => diff.kind === 'new')).toBe(true)
    expect(result.patterns?.every((diff) => !('targetRowIds' in diff))).toBe(true)
    expect(result.facets?.map((f) => f.facet)).toEqual(['service'])
    expect(result.onset?.time).toBe('2026-07-14T09:05:00.000Z')
    expect(result.onset?.precedingEvent?.event.title).toBe('Deploy payments v9')
    expect(result.onset?.precedingEvent?.leadTimeMs).toBe(60_000)
    expect(result.fetchedAt).toBe(new Date(NOW_MS).toISOString())
  })

  it('omits patterns, facets, onset and notices as absent keys when they have no content', async () => {
    client.aggregateTimeseriesByStatus.mockResolvedValue([])
    const result = await run({ facets: [], includePatterns: false, includeEvents: false })
    expect('patterns' in result).toBe(false)
    expect('facets' in result).toBe(false)
    expect('onset' in result).toBe(false)
    expect('notices' in result).toBe(false)
  })

  describe('precomputed target window', () => {
    const precomputed = (overrides: Partial<PrecomputedTargetWindow> = {}): PrecomputedTargetWindow => ({
      range: { fromMs: Date.parse(TARGET_FROM), toMs: Date.parse(TARGET_TO) },
      interval: { label: INTERVAL, ms: 60_000 },
      statusFacet: {
        facet: 'status',
        values: [
          { value: 'info', count: 70 },
          { value: 'error', count: 30 },
        ],
      } satisfies FacetBreakdown,
      timeline: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map<TimelineBucket>((index) => ({
        time: new Date(Date.parse(TARGET_FROM) + index * 60_000).toISOString(),
        counts: { info: 100, error: RISING_ERRORS[index] },
      })),
      rows: targetLogs().map((log) => ({
        id: log.id ?? '',
        timestamp: '2026-07-14T09:30:00.000Z',
        status: 'error',
        message: log.attributes?.message ?? '',
      })),
      rowsTruncated: false,
      events: [{ id: 'e1', time: '2026-07-14T09:04:00.000Z', kind: 'deploy', title: 'Deploy payments v9' }],
      facets: [
        {
          facet: 'service',
          values: [
            { value: 'payments', count: 60 },
            { value: 'web', count: 40 },
          ],
        },
      ],
      ...overrides,
    })

    it('issues zero target-side calls and still produces a complete result', async () => {
      const result = await run({ precomputedTarget: precomputed() })
      expect(client.calls).toEqual([
        'facet:status@baseline',
        'timeline@baseline',
        'facet:service@baseline',
        'search@baseline',
      ])
      expect(callCount()).toBe(4)
      expect(client.maxInFlight()).toBe(1)
      expect(result.target.totalCount).toBe(100)
      expect(result.baseline.totalCount).toBe(200)
      expect(result.interval).toBe(INTERVAL)
      expect(result.patterns?.length).toBeGreaterThan(0)
      expect(result.facets?.[0].facet).toBe('service')
      expect(result.onset?.precedingEvent?.event.id).toBe('e1')
    })

    it('skips a facet the reused window does not carry, without spending a baseline call on it', async () => {
      const result = await run({ precomputedTarget: precomputed({ facets: [] }) })
      expect(client.calls).toEqual(['facet:status@baseline', 'timeline@baseline', 'search@baseline'])
      expect('facets' in result).toBe(false)
      expect(result.notices?.some((n) => n.includes('not part of the reused target window'))).toBe(true)
    })

    it('treats an empty reused sample as no sample rather than diffing against nothing', async () => {
      // Otherwise every baseline template comes back "gone", which reads as a
      // resolved incident instead of as a target window with no rows fetched.
      const result = await run({ precomputedTarget: precomputed({ rows: [] }) })
      expect('patterns' in result).toBe(false)
      expect(client.calls).not.toContain('search@baseline')
    })
  })

  describe('degradation', () => {
    it('throws when the status aggregation fails — there is nothing left to compare', async () => {
      client.aggregateByFacet.mockRejectedValueOnce({ code: 403, message: 'Forbidden' })
      await expect(run()).rejects.toMatchObject({ code: 403 })
    })

    it('turns an events failure into a notice and keeps the rest of the result', async () => {
      client.searchEvents.mockRejectedValue({ code: 403, message: 'Forbidden' })
      const result = await run()
      expect(result.notices?.some((n) => n.includes('Events unavailable') && n.includes('events_read'))).toBe(true)
      expect(result.patterns?.length).toBeGreaterThan(0)
      expect(result.facets?.length).toBe(1)
      expect(result.onset).toBeDefined()
      expect('precedingEvent' in (result.onset ?? {})).toBe(false)
    })

    it('turns a target facet failure into a notice, omits facets, and skips the baseline facet call', async () => {
      client.aggregateByFacet.mockImplementationOnce(async () => countBuckets('status', { error: 30, info: 70 }))
      client.aggregateByFacet.mockRejectedValueOnce({ code: 403, message: 'Forbidden' })
      const result = await run()
      expect(result.notices?.some((n) => n.includes('Facet "service" unavailable for the target window'))).toBe(true)
      expect('facets' in result).toBe(false)
      expect(client.aggregateByFacet.mock.calls.filter((call) => call[0].facet === 'service')).toHaveLength(1)
    })

    it('turns a baseline facet failure into a notice and omits facets', async () => {
      client.aggregateByFacet.mockImplementation(async (params: CallParams) => {
        if (params.facet === 'service' && windowOf(params.from) === 'baseline') {
          throw { code: 403, message: 'Forbidden' }
        }
        return params.facet === 'status'
          ? countBuckets('status', { error: 30, info: 70 })
          : countBuckets('service', { payments: 60 })
      })
      const result = await run()
      expect(result.notices?.some((n) => n.includes('Facet "service" unavailable for the baseline window'))).toBe(true)
      expect('facets' in result).toBe(false)
    })

    it('turns a pattern-sample failure into a notice and omits patterns', async () => {
      client.searchLogs.mockRejectedValue({ code: 403, message: 'Forbidden' })
      const result = await run()
      expect(result.notices?.some((n) => n.includes('Pattern samples unavailable for the target window'))).toBe(true)
      expect('patterns' in result).toBe(false)
      expect(result.facets?.length).toBe(1)
    })

    it('turns a timeline failure into a notice and omits the onset', async () => {
      client.aggregateTimeseriesByStatus.mockRejectedValue({ code: 403, message: 'Forbidden' })
      const result = await run()
      expect(result.notices?.some((n) => n.includes('Timeline unavailable'))).toBe(true)
      expect('onset' in result).toBe(false)
    })
  })

  describe('notices', () => {
    it('flags the sampling bias when a window hits the row cap', async () => {
      client.searchLogs.mockImplementation(async (params: CallParams) => ({
        logs: windowOf(params.from) === 'target' ? targetLogs(params.limit ?? 0) : baselineLogs(),
      }))
      const result = await run({ sampleLimit: 5 })
      const bias = result.notices?.find((n) => n.includes('sampled the most recent'))
      expect(bias).toContain('most recent 5 of ~100 logs in the target window')
      expect(bias).toContain('skew toward the end of the window')
      expect(result.notices?.filter((n) => n.includes('sampled the most recent'))).toHaveLength(1)
    })

    it('emits no sampling-bias notice when neither window truncates', async () => {
      const result = await run()
      expect(result.notices?.some((n) => n.includes('sampled the most recent'))).not.toBe(true)
    })

    it('flags facet coverage when the fetched values miss part of the window', async () => {
      client.aggregateByFacet.mockImplementation(async (params: CallParams) =>
        params.facet === 'status'
          ? countBuckets('status', windowOf(params.from) === 'target' ? { error: 30, info: 70 } : { info: 200 })
          : countBuckets('service', { payments: 10 })
      )
      const result = await run()
      expect(
        result.notices?.some((n) => n.includes('Facet "service" covers 10 of 100 logs in the target window'))
      ).toBe(true)
      expect(result.notices?.some((n) => n.includes('values past the top 100 are excluded'))).toBe(true)
    })

    it('flags a low-sample window', async () => {
      client.aggregateByFacet.mockImplementation(async (params: CallParams) =>
        params.facet === 'status'
          ? countBuckets('status', windowOf(params.from) === 'target' ? { error: 3 } : { info: 200 })
          : countBuckets('service', { payments: 3 })
      )
      const result = await run()
      expect(result.target.lowSample).toBe(true)
      expect(result.notices?.some((n) => n.includes('target window holds only 3 logs'))).toBe(true)
    })

    it('flags an overlapping custom baseline instead of throwing', async () => {
      const result = await run({ baselineFrom: '2026-07-14T09:30:00Z', baselineTo: '2026-07-14T10:30:00Z' })
      expect(result.params.mode).toBe('custom')
      expect(result.notices?.some((n) => n.includes('baseline window overlaps the target window'))).toBe(true)
      expect(result.baseline.fromMs).toBe(Date.parse('2026-07-14T09:30:00Z'))
    })
  })
})
