import { describe, expect, it, vi } from 'vitest'
import { DatadogLogsClient } from '../client.js'

function createClient() {
  const aggregateLogs = vi.fn().mockResolvedValue({ data: { buckets: [] } })
  const client = new DatadogLogsClient({
    apiKey: 'test-api-key',
    appKey: 'test-app-key',
    site: 'datadoghq.com',
  })
  ;(client as unknown as { api: { aggregateLogs: typeof aggregateLogs } }).api = { aggregateLogs }
  return { client, aggregateLogs }
}

function createSpansClient() {
  const listSpans = vi.fn()
  const client = new DatadogLogsClient({
    apiKey: 'test-api-key',
    appKey: 'test-app-key',
    site: 'datadoghq.com',
  })
  ;(client as unknown as { spansApi: { listSpans: typeof listSpans } }).spansApi = { listSpans }
  return { client, listSpans }
}

function createEventsClient() {
  const searchEvents = vi.fn()
  const client = new DatadogLogsClient({
    apiKey: 'test-api-key',
    appKey: 'test-app-key',
    site: 'datadoghq.com',
  })
  ;(client as unknown as { eventsApi: { searchEvents: typeof searchEvents } }).eventsApi = { searchEvents }
  return { client, searchEvents }
}

/** Configured with log indexes on purpose: monitors must never inherit them. */
function createMonitorsClient() {
  const searchMonitors = vi.fn()
  const client = new DatadogLogsClient({
    apiKey: 'test-api-key',
    appKey: 'test-app-key',
    site: 'datadoghq.com',
    indexes: ['idx'],
  })
  ;(client as unknown as { monitorsApi: { searchMonitors: typeof searchMonitors } }).monitorsApi = { searchMonitors }
  return { client, searchMonitors }
}

describe('DatadogLogsClient aggregation', () => {
  it('uses the requested facet for a timeseries aggregation', async () => {
    const { client, aggregateLogs } = createClient()

    await client.aggregateTimeseriesByFacet({
      query: 'service:web',
      from: 'now-1h',
      to: 'now',
      interval: '15m',
      facet: 'host',
    })

    expect(aggregateLogs).toHaveBeenCalledWith({
      body: {
        compute: [{ aggregation: 'count', type: 'timeseries', interval: '15m' }],
        filter: { query: 'service:web', from: 'now-1h', to: 'now' },
        groupBy: [{ facet: 'host', limit: 50 }],
      },
    })
  })

  it('keeps the investigation status timeline capped at 10 values', async () => {
    const { client, aggregateLogs } = createClient()

    await client.aggregateTimeseriesByStatus({ query: '*', from: 'now-15m', to: 'now', interval: '5m' })

    expect(aggregateLogs.mock.calls[0][0].body.groupBy).toEqual([{ facet: 'status', limit: 10 }])
  })
})

describe('DatadogLogsClient.listTraceSpans', () => {
  it('queries by trace_id in ascending timestamp order', async () => {
    const { client, listSpans } = createSpansClient()
    listSpans.mockResolvedValue({ data: [{ id: 's1' }], meta: { page: {} } })

    const result = await client.listTraceSpans({ traceId: 'abc123', from: 'now-1h', to: 'now' })

    expect(listSpans).toHaveBeenCalledWith({
      body: {
        data: {
          type: 'search_request',
          attributes: {
            filter: { query: 'trace_id:abc123', from: 'now-1h', to: 'now' },
            sort: 'timestamp',
            page: { limit: 200 },
          },
        },
      },
    })
    expect(result).toEqual({ spans: [{ id: 's1' }], truncated: false })
  })

  it('follows pagination cursors and concatenates pages', async () => {
    const { client, listSpans } = createSpansClient()
    listSpans
      .mockResolvedValueOnce({ data: [{ id: 's1' }], meta: { page: { after: 'cursor-1' } } })
      .mockResolvedValueOnce({ data: [{ id: 's2' }], meta: { page: {} } })

    const result = await client.listTraceSpans({ traceId: 'abc123', from: 'now-1h', to: 'now' })

    expect(listSpans).toHaveBeenCalledTimes(2)
    expect(listSpans.mock.calls[1][0].body.data.attributes.page).toEqual({ limit: 200, cursor: 'cursor-1' })
    expect(result.spans.map((span: { id?: string }) => span.id)).toEqual(['s1', 's2'])
    expect(result.truncated).toBe(false)
  })

  it('stops at the span cap and reports truncation', async () => {
    const { client, listSpans } = createSpansClient()
    listSpans
      .mockResolvedValueOnce({ data: [{ id: 's1' }, { id: 's2' }], meta: { page: { after: 'cursor-1' } } })
      .mockResolvedValueOnce({ data: [{ id: 's3' }], meta: { page: { after: 'cursor-2' } } })

    const result = await client.listTraceSpans({ traceId: 'abc123', from: 'now-1h', to: 'now', maxSpans: 3 })

    expect(listSpans).toHaveBeenCalledTimes(2)
    expect(listSpans.mock.calls[1][0].body.data.attributes.page).toEqual({ limit: 1, cursor: 'cursor-1' })
    expect(result.spans).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })
})

describe('DatadogLogsClient.searchEvents', () => {
  it('sends a single-page events search in ascending timestamp order', async () => {
    const { client, searchEvents } = createEventsClient()
    searchEvents.mockResolvedValue({ data: [{ id: 'e1' }] })

    const events = await client.searchEvents({ query: 'source:github', from: 'now-1d', to: 'now', limit: 25 })

    expect(searchEvents).toHaveBeenCalledWith({
      body: {
        filter: { query: 'source:github', from: 'now-1d', to: 'now' },
        sort: 'timestamp',
        page: { limit: 25 },
      },
    })
    expect(events).toEqual([{ id: 'e1' }])
  })

  it('returns an empty array when the response has no data', async () => {
    const { client, searchEvents } = createEventsClient()
    searchEvents.mockResolvedValue({})

    await expect(client.searchEvents({ query: '*', from: 'now-1d', to: 'now', limit: 5 })).resolves.toEqual([])
  })
})

describe('DatadogLogsClient.searchMonitors', () => {
  it('never sends log index scoping to the monitors search', async () => {
    const { client, searchMonitors } = createMonitorsClient()
    searchMonitors.mockResolvedValue({ monitors: [{ id: 1 }], metadata: { totalCount: 7 } })

    const result = await client.searchMonitors({ query: 'status:Alert', perPage: 25 })

    // Exact match: no `indexes` key, and no `sort` key when the caller supplied none.
    expect(searchMonitors).toHaveBeenCalledWith({ query: 'status:Alert', page: 0, perPage: 25 })
    expect(JSON.stringify(searchMonitors.mock.calls[0][0])).not.toContain('idx')
    expect(result).toEqual({ monitors: [{ id: 1 }], totalCount: 7 })
  })

  it('forwards the API sort key and page when supplied', async () => {
    const { client, searchMonitors } = createMonitorsClient()
    searchMonitors.mockResolvedValue({ monitors: [] })

    await client.searchMonitors({ query: '*', perPage: 100, page: 2, sort: 'status,asc' })

    expect(searchMonitors).toHaveBeenCalledWith({ query: '*', page: 2, perPage: 100, sort: 'status,asc' })
  })

  it('omits totalCount when Datadog reports no metadata', async () => {
    const { client, searchMonitors } = createMonitorsClient()
    searchMonitors.mockResolvedValue({ monitors: [{ id: 1 }] })

    const result = await client.searchMonitors({ query: '*', perPage: 25 })

    expect('totalCount' in result).toBe(false)
    expect(result.monitors).toEqual([{ id: 1 }])
  })

  it('returns an empty monitor list when the response has none', async () => {
    const { client, searchMonitors } = createMonitorsClient()
    searchMonitors.mockResolvedValue({ metadata: {} })

    await expect(client.searchMonitors({ query: '*', perPage: 25 })).resolves.toEqual({ monitors: [] })
  })
})
