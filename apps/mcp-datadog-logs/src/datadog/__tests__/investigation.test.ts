import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatadogLogsClient } from '../client.js'
import { extractTraceCandidates, runInvestigation } from '../investigation.js'
import type { RawLog } from '../normalize.js'

const FROM = '2026-07-14T09:00:00Z'
const TO = '2026-07-14T10:00:00Z'

function rawLog(id: string, overrides: Partial<NonNullable<RawLog['attributes']>> = {}): RawLog {
  return {
    id,
    attributes: {
      timestamp: '2026-07-14T09:30:00Z',
      status: 'error',
      service: 'payments',
      message: `boom ${id}`,
      ...overrides,
    },
  }
}

function fakeClient() {
  return {
    searchLogs: vi.fn().mockResolvedValue({ logs: [rawLog('log-1', { attributes: { trace_id: 'trace-a' } })] }),
    aggregateTimeseriesByStatus: vi.fn().mockResolvedValue([]),
    aggregateByFacet: vi.fn().mockResolvedValue([]),
    searchEvents: vi.fn().mockResolvedValue([
      {
        id: 'e1',
        attributes: {
          timestamp: '2026-07-14T09:15:00Z',
          attributes: { title: 'Deploy web v2', sourceTypeName: 'github', status: 'info' },
        },
      },
    ]),
    queryMetrics: vi.fn().mockResolvedValue([
      {
        metric: 'avg:system.cpu.user',
        pointlist: [[Date.parse(FROM), 10]],
      },
    ]),
  }
}

describe('runInvestigation cross-source fetches', () => {
  let client: ReturnType<typeof fakeClient>

  beforeEach(() => {
    client = fakeClient()
  })

  const run = (params: Record<string, unknown> = {}) =>
    runInvestigation(client as unknown as DatadogLogsClient, { query: '*', from: FROM, to: TO, ...params })

  it('fetches events by default and stores sorted markers', async () => {
    const { result } = await run()
    expect(client.searchEvents).toHaveBeenCalledWith({ query: '*', from: FROM, to: TO, limit: 30 })
    expect(result.events).toHaveLength(1)
    expect(result.events?.[0]).toMatchObject({ id: 'e1', kind: 'deploy', title: 'Deploy web v2' })
    expect(result.notices).toBeUndefined()
  })

  it('passes eventsQuery through and skips events with includeEvents: false', async () => {
    await run({ eventsQuery: 'source:github' })
    expect(client.searchEvents).toHaveBeenCalledWith(expect.objectContaining({ query: 'source:github' }))

    client.searchEvents.mockClear()
    const { result } = await run({ includeEvents: false })
    expect(client.searchEvents).not.toHaveBeenCalled()
    expect(result.events).toBeUndefined()
  })

  it('fetches each metrics query with the resolved range in epoch seconds', async () => {
    const { result } = await run({ metricsQueries: ['avg:system.cpu.user{*}', 'avg:trace.req{*}'] })
    expect(client.queryMetrics).toHaveBeenCalledTimes(2)
    expect(client.queryMetrics).toHaveBeenCalledWith({
      query: 'avg:system.cpu.user{*}',
      fromSec: Math.floor(Date.parse(FROM) / 1000),
      toSec: Math.floor(Date.parse(TO) / 1000),
    })
    expect(result.metrics).toHaveLength(2)
  })

  it('caps metricsQueries at 4', async () => {
    await run({ metricsQueries: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] })
    expect(client.queryMetrics).toHaveBeenCalledTimes(4)
  })

  it('skips events and metrics on load-more (cursor) pages', async () => {
    const { result } = await run({ cursor: 'page-2', metricsQueries: ['q1'] })
    expect(client.searchEvents).not.toHaveBeenCalled()
    expect(client.queryMetrics).not.toHaveBeenCalled()
    expect(result.events).toBeUndefined()
    expect(result.metrics).toBeUndefined()
  })

  it('degrades gracefully when the events scope is missing', async () => {
    client.searchEvents.mockRejectedValue({ code: 403, message: 'Forbidden' })
    const { result } = await run()
    expect(result.events).toBeUndefined()
    expect(result.notices).toHaveLength(1)
    expect(result.notices?.[0]).toContain('Events unavailable')
    expect(result.notices?.[0]).toContain('events_read')
    expect(result.rows).toHaveLength(1)
  })

  it('continues with the remaining metric queries when one fails', async () => {
    client.queryMetrics.mockRejectedValueOnce({ code: 403, message: 'Forbidden' })
    const { result } = await run({ metricsQueries: ['bad{*}', 'good{*}'] })
    expect(result.metrics).toHaveLength(1)
    expect(result.notices?.[0]).toContain('bad{*}')
    expect(result.notices?.[0]).toContain('timeseries_query')
  })

  it('extracts trace candidates from the fetched rows', async () => {
    client.searchLogs.mockResolvedValue({
      logs: [
        rawLog('log-1', { attributes: { trace_id: 'trace-a' } }),
        rawLog('log-2', { attributes: { trace_id: 'trace-a' } }),
        rawLog('log-3', { status: 'info', attributes: { trace_id: 'trace-b' } }),
        rawLog('log-4'),
      ],
    })
    const { result } = await run()
    expect(result.traceCandidates?.map((c) => c.traceId)).toEqual(['trace-a', 'trace-b'])
    expect(result.traceCandidates?.[0]).toMatchObject({ count: 2, errorCount: 2, services: ['payments'] })
  })

  it('produces the legacy result shape when cross-source data is absent', async () => {
    client.searchLogs.mockResolvedValue({ logs: [rawLog('log-1')] })
    const { result } = await run({ includeEvents: false })
    expect(Object.keys(result)).not.toContain('events')
    expect(Object.keys(result)).not.toContain('metrics')
    expect(Object.keys(result)).not.toContain('traceCandidates')
    expect(Object.keys(result)).not.toContain('comparison')
    expect(Object.keys(result)).not.toContain('notices')
  })
})

describe('runInvestigation baseline comparison', () => {
  let client: ReturnType<typeof fakeClient>

  beforeEach(() => {
    client = fakeClient()
  })

  const run = (params: Record<string, unknown> = {}) =>
    runInvestigation(client as unknown as DatadogLogsClient, {
      query: 'service:payments',
      from: FROM,
      to: TO,
      ...params,
    })

  /** Requests a plain investigation issues: 1 search + 1 timeseries + 3 facets. */
  const BASE_CALLS = { searchLogs: 1, aggregateTimeseriesByStatus: 1, aggregateByFacet: 3 }

  const callCounts = () => ({
    searchLogs: client.searchLogs.mock.calls.length,
    aggregateTimeseriesByStatus: client.aggregateTimeseriesByStatus.mock.calls.length,
    aggregateByFacet: client.aggregateByFacet.mock.calls.length,
  })

  it('issues no extra requests and grows no comparison key without a baseline param', async () => {
    const { result } = await run()
    expect(callCounts()).toEqual(BASE_CALLS)
    expect(Object.keys(result)).not.toContain('comparison')
  })

  it('compares against the baseline window when one is requested', async () => {
    const { result } = await run({ baseline: '1d' })
    expect(result.comparison).toBeDefined()
    expect(result.comparison?.params.mode).toBe('shift')
    expect(result.comparison?.params.shift).toBe('1d')
    // 1 target facet re-fetch + the baseline window (status, timeline, facet, sample).
    const counts = callCounts()
    expect(counts.searchLogs).toBe(BASE_CALLS.searchLogs + 1)
    expect(counts.aggregateTimeseriesByStatus).toBe(BASE_CALLS.aggregateTimeseriesByStatus + 1)
    expect(counts.aggregateByFacet).toBe(BASE_CALLS.aggregateByFacet + 3)
  })

  it('runs the comparison on baselineFrom / baselineTo alone', async () => {
    const fromOnly = await run({ baselineFrom: '2026-07-13T09:00:00Z' })
    expect(fromOnly.result.comparison).toBeDefined()

    client = fakeClient()
    const toOnly = await run({ baselineTo: '2026-07-13T10:00:00Z' })
    expect(toOnly.result.comparison).toBeDefined()
  })

  it('samples both windows unscoped, so the target rows can be reused verbatim', async () => {
    await run({ baseline: '1d' })
    // scope '' keeps the pattern samples on both sides at the investigation's
    // own query; the default 'status:error' would compare an all-status target
    // sample against an errors-only baseline sample.
    const sampleQueries = client.searchLogs.mock.calls.map((call) => call[0].query)
    expect(sampleQueries).toEqual(['service:payments', 'service:payments'])
    expect(client.searchEvents).toHaveBeenCalledTimes(1)
  })

  it('re-fetches the compared facet at the comparison cap instead of reusing the 15-value breakdown', async () => {
    // 20 services: a breakdown normalized with the investigation's own caps
    // would cover only the top 15 and report the rest as absent.
    const serviceBuckets = Array.from({ length: 20 }, (_, i) => ({
      by: { service: `svc-${i}` },
      computes: { c0: 20 - i },
    }))
    client.aggregateByFacet.mockImplementation((params: { facet: string }) =>
      Promise.resolve(params.facet === 'service' ? serviceBuckets : [])
    )

    const { result } = await run({ baseline: '1d' })
    const facetCalls = client.aggregateByFacet.mock.calls.map((call) => call[0])
    expect(facetCalls.filter((call) => call.facet === 'service' && call.limit === 100)).toHaveLength(2)
    // The investigation's own breakdown is still capped at 15 …
    expect(result.facets.find((f) => f.facet === 'service')?.values).toHaveLength(15)
    // … while the comparison attributes over all 20 values (sum 20+19+…+1).
    const attribution = result.comparison?.facets?.[0]
    expect(attribution?.facet).toBe('service')
    expect(attribution?.targetCovered).toBe(210)
  })

  it('does not re-fetch the comparison on load-more (cursor) pages', async () => {
    const { result } = await run({ baseline: '1d', cursor: 'page-2' })
    expect(callCounts()).toEqual(BASE_CALLS)
    expect(Object.keys(result)).not.toContain('comparison')
  })

  it('degrades to a notice when the comparison fails', async () => {
    // The baseline window's status aggregation is the one source runComparison
    // lets throw; it is the second 'status' facet call of the run.
    client.aggregateByFacet.mockImplementation((params: { facet: string; limit?: number }) => {
      if (params.facet === 'status' && params.limit === 20) {
        return Promise.reject({ code: 403, message: 'Forbidden' })
      }
      return Promise.resolve([])
    })
    const { result } = await run({ baseline: '1d' })
    expect(Object.keys(result)).not.toContain('comparison')
    expect(result.rows).toHaveLength(1)
    expect(result.notices?.some((n) => n.startsWith('Baseline comparison unavailable'))).toBe(true)
  })

  it('keeps comparing when the target facet re-fetch fails', async () => {
    client.aggregateByFacet.mockImplementation((params: { facet: string; limit?: number }) => {
      if (params.facet === 'service' && params.limit === 100) {
        return Promise.reject({ code: 403, message: 'Forbidden' })
      }
      return Promise.resolve([])
    })
    const { result } = await run({ baseline: '1d' })
    expect(result.comparison).toBeDefined()
    expect(result.notices?.some((n) => n.startsWith('Comparison facet attribution unavailable'))).toBe(true)
  })
})

describe('extractTraceCandidates', () => {
  const row = (id: string, traceId: string | undefined, status = 'error', timestamp = '2026-07-14T09:30:00.000Z') => ({
    id,
    timestamp,
    status,
    service: 'payments',
    message: `msg ${id}`,
    ...(traceId ? { traceId } : {}),
  })

  it('sorts by error count, then row count, and caps the list', () => {
    const rows = [
      row('1', 'a', 'info'),
      row('2', 'a', 'info'),
      row('3', 'a', 'info'),
      row('4', 'b'),
      row('5', 'b'),
      row('6', 'c'),
      row('7', undefined),
    ]
    const candidates = extractTraceCandidates(rows, 2)
    expect(candidates.map((c) => c.traceId)).toEqual(['b', 'c'])
    expect(candidates[0]).toMatchObject({ count: 2, errorCount: 2 })
  })

  it('tracks the earliest timestamp and prefers an error message as the sample', () => {
    const rows = [row('1', 'a', 'info', '2026-07-14T09:10:00.000Z'), row('2', 'a', 'error', '2026-07-14T09:20:00.000Z')]
    const [candidate] = extractTraceCandidates(rows)
    expect(candidate.firstSeen).toBe('2026-07-14T09:10:00.000Z')
    expect(candidate.sampleMessage).toBe('msg 2')
  })

  it('returns an empty list when no rows carry a trace id', () => {
    expect(extractTraceCandidates([row('1', undefined)])).toEqual([])
  })
})
