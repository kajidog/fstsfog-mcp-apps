import { client, v1, v2 } from '@datadog/datadog-api-client'
import type { DatadogConfig } from '../config.js'
import { getDatadogConfig } from '../config.js'
import type { RawAggregateBucket, RawEvent, RawLog, RawMetricSeries, RawMonitor, RawSpan } from './normalize.js'

export interface SearchLogsParams {
  query: string
  from: string
  to: string
  limit: number
  sort?: 'timestamp' | '-timestamp'
  cursor?: string
}

export interface SearchLogsResult {
  logs: RawLog[]
  nextCursor?: string
}

export interface AggregateParams {
  query: string
  from: string
  to: string
}

export interface ListTraceSpansParams {
  traceId: string
  from: string
  to: string
  /** Fetch cap across pages. Default 500. */
  maxSpans?: number
}

export interface ListTraceSpansResult {
  spans: RawSpan[]
  /** True when the cap was hit and more spans exist. */
  truncated: boolean
}

export interface SearchEventsParams {
  query: string
  from: string
  to: string
  limit: number
}

export interface QueryMetricsParams {
  /** Classic metric query string, e.g. "avg:system.cpu.user{service:web} by {host}" */
  query: string
  /** Epoch seconds — the v1 query API does not accept time-math strings */
  fromSec: number
  toSec: number
}

export interface SearchMonitorsParams {
  /** Datadog monitor search query, e.g. 'status:Alert tag:"service:web"' */
  query: string
  /** 0-based page index. Default 0. */
  page?: number
  perPage: number
  /** API sort key, e.g. "status,asc". Only name/status/tags are supported by the API. */
  sort?: string
}

export interface SearchMonitorsResult {
  monitors: RawMonitor[]
  /** Total monitors matching the query across all pages, when Datadog reports it. */
  totalCount?: number
}

const SPANS_PAGE_LIMIT = 200

/** Datadog API client wrapper. Despite the name it also covers spans, events, metrics, and monitors. */
export class DatadogLogsClient {
  private readonly api: v2.LogsApi
  private readonly spansApi: v2.SpansApi
  private readonly eventsApi: v2.EventsApi
  private readonly metricsApi: v1.MetricsApi
  private readonly monitorsApi: v1.MonitorsApi
  private readonly indexes?: string[]
  readonly site: string

  constructor(config: DatadogConfig) {
    const configuration = client.createConfiguration({
      authMethods: {
        apiKeyAuth: config.apiKey,
        appKeyAuth: config.appKey,
      },
      // The Datadog SDK retries 429/5xx responses and honors
      // X-RateLimit-Reset when Datadog returns it.
      enableRetry: true,
      maxRetries: 3,
      backoffBase: 2,
      backoffMultiplier: 2,
    })
    configuration.setServerVariables({ site: config.site })
    this.api = new v2.LogsApi(configuration)
    this.spansApi = new v2.SpansApi(configuration)
    this.eventsApi = new v2.EventsApi(configuration)
    this.metricsApi = new v1.MetricsApi(configuration)
    this.monitorsApi = new v1.MonitorsApi(configuration)
    this.indexes = config.indexes
    this.site = config.site
  }

  private filter(params: AggregateParams): v2.LogsQueryFilter {
    return {
      query: params.query,
      from: params.from,
      to: params.to,
      ...(this.indexes ? { indexes: this.indexes } : {}),
    }
  }

  async searchLogs(params: SearchLogsParams): Promise<SearchLogsResult> {
    const response = await this.api.listLogs({
      body: {
        filter: this.filter(params),
        sort: params.sort ?? '-timestamp',
        page: {
          limit: params.limit,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
      },
    })
    return {
      logs: (response.data ?? []) as RawLog[],
      nextCursor: response.meta?.page?.after,
    }
  }

  /** Timeseries log counts grouped by a single facet. */
  async aggregateTimeseriesByFacet(
    params: AggregateParams & { interval: string; facet: string; limit?: number }
  ): Promise<RawAggregateBucket[]> {
    const response = await this.api.aggregateLogs({
      body: {
        compute: [{ aggregation: 'count', type: 'timeseries', interval: params.interval }],
        filter: this.filter(params),
        groupBy: [{ facet: params.facet, limit: params.limit ?? 50 }],
      },
    })
    return (response.data?.buckets ?? []) as RawAggregateBucket[]
  }

  /** Status-grouped timeline used by the investigation UI. */
  async aggregateTimeseriesByStatus(params: AggregateParams & { interval: string }): Promise<RawAggregateBucket[]> {
    return this.aggregateTimeseriesByFacet({ ...params, facet: 'status', limit: 10 })
  }

  /** Total log counts grouped by a single facet (e.g. service, host, @http.status_code). */
  async aggregateByFacet(params: AggregateParams & { facet: string; limit?: number }): Promise<RawAggregateBucket[]> {
    const response = await this.api.aggregateLogs({
      body: {
        compute: [{ aggregation: 'count', type: 'total' }],
        filter: this.filter(params),
        groupBy: [
          {
            facet: params.facet,
            limit: params.limit ?? 50,
            sort: { aggregation: 'count', order: 'desc', type: 'measure' },
          },
        ],
      },
    })
    return (response.data?.buckets ?? []) as RawAggregateBucket[]
  }

  /** All spans of one APM trace, ascending by start time, following cursors up to maxSpans. */
  async listTraceSpans(params: ListTraceSpansParams): Promise<ListTraceSpansResult> {
    const cap = params.maxSpans ?? 500
    const spans: RawSpan[] = []
    let cursor: string | undefined
    do {
      const response = await this.spansApi.listSpans({
        body: {
          data: {
            type: 'search_request',
            attributes: {
              filter: { query: `trace_id:${params.traceId}`, from: params.from, to: params.to },
              sort: 'timestamp',
              page: {
                limit: Math.min(SPANS_PAGE_LIMIT, cap - spans.length),
                ...(cursor ? { cursor } : {}),
              },
            },
          },
        },
      })
      spans.push(...((response.data ?? []) as RawSpan[]))
      cursor = response.meta?.page?.after
    } while (cursor && spans.length < cap)
    return { spans, truncated: Boolean(cursor) && spans.length >= cap }
  }

  /**
   * Timeseries points for a classic metric query (v1 query API — the stable
   * "query string in, series out" endpoint; the v2 equivalent is still
   * marked unstable in the SDK).
   */
  async queryMetrics(params: QueryMetricsParams): Promise<RawMetricSeries[]> {
    const response = await this.metricsApi.queryMetrics({
      from: params.fromSec,
      to: params.toSec,
      query: params.query,
    })
    return (response.series ?? []) as RawMetricSeries[]
  }

  /** Single page of Datadog events (deployments, monitor alerts, ...) matching an events search query. */
  async searchEvents(params: SearchEventsParams): Promise<RawEvent[]> {
    const response = await this.eventsApi.searchEvents({
      body: {
        filter: { query: params.query, from: params.from, to: params.to },
        sort: 'timestamp',
        page: { limit: params.limit },
      },
    })
    return (response.data ?? []) as RawEvent[]
  }

  /**
   * Single page of monitors matching a monitor search query (searchMonitors —
   * unlike listMonitors it paginates and returns the flat status /
   * lastTriggeredTs fields).
   *
   * this.filter() / DD_LOGS_INDEXES deliberately does not apply here: monitors
   * are not stored in log indexes, so index scoping is meaningless for them.
   */
  async searchMonitors(params: SearchMonitorsParams): Promise<SearchMonitorsResult> {
    const response = await this.monitorsApi.searchMonitors({
      query: params.query,
      page: params.page ?? 0,
      perPage: params.perPage,
      ...(params.sort ? { sort: params.sort } : {}),
    })
    const totalCount = response.metadata?.totalCount
    return {
      monitors: (response.monitors ?? []) as RawMonitor[],
      ...(totalCount !== undefined ? { totalCount } : {}),
    }
  }
}

let cached: DatadogLogsClient | undefined

/** Lazy singleton so the server can start without credentials. */
export function getDatadogClient(): DatadogLogsClient {
  if (!cached) {
    cached = new DatadogLogsClient(getDatadogConfig())
  }
  return cached
}

/** Test hook. */
export function resetDatadogClient(): void {
  cached = undefined
}

/**
 * Maps Datadog API failures to actionable messages for the model/user.
 * `requiredScope` names the application-key scope the failing API needs
 * (logs tools: logs_read_data, spans: apm_read, events: events_read,
 * metrics: timeseries_query, monitors: monitors_read).
 */
export function describeDatadogError(error: unknown, requiredScope = 'logs_read_data'): string {
  const err = error as { code?: number; message?: string } | undefined
  const code = err?.code
  const message = err?.message ?? String(error)
  if (code === 403) {
    return (
      'Datadog API returned 403 Forbidden. Check that DD_API_KEY and DD_APP_KEY are valid, ' +
      `the application key has the ${requiredScope} scope, and DD_SITE matches your Datadog region.`
    )
  }
  if (code === 401) {
    return (
      'Datadog API returned 401 Unauthorized. Check that DD_API_KEY is valid, ' +
      'DD_SITE matches the Datadog region where the key was created, and DD_APP_KEY belongs to the same org.'
    )
  }
  if (code === 429) {
    return (
      'Datadog API rate limit exceeded (429). Wait for the Datadog rate-limit window to reset, ' +
      'then retry with a narrower time range, fewer repeated refreshes, or fewer concurrent MCP clients.'
    )
  }
  if (code === 400) {
    return `Datadog API rejected the request (400). Check the query syntax and time range. Details: ${message}`
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    return `Could not reach the Datadog API. Check network access and DD_SITE. Details: ${message}`
  }
  // Config/validation errors raised by this server already carry actionable text.
  if (/credentials are not configured|Unrecognized time value|Invalid time range/.test(message)) {
    return message
  }
  return `Datadog API error: ${message}`
}
