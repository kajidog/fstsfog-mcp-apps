import type {
  ComparisonResult,
  EventMarker,
  FacetBreakdown,
  InvestigationParams,
  InvestigationResult,
  LogRow,
  MetricSeries,
  TraceCandidate,
} from '@kajidog/investigation-shared'
import { getServerConfig, HARD_MAX_ROWS } from '../config.js'
import type { DatadogLogsClient } from './client.js'
import { describeDatadogError } from './client.js'
import { runComparison } from './comparison.js'
import type { RawAggregateBucket, RawLog } from './normalize.js'
import {
  DEFAULT_CAPS,
  type NormalizeCaps,
  normalizeEventMarker,
  normalizeFacet,
  normalizeLogRow,
  normalizeMetricSeries,
  normalizeTimeline,
} from './normalize.js'
import { pickInterval, resolveRange } from './time.js'

export interface InvestigationOutput {
  result: InvestigationResult
  /** Full raw log events keyed by id — served via _get_log_detail. */
  rawById: Map<string, RawLog>
}

const BASE_FACETS = ['service', 'status', 'host']
const MAX_EVENTS = 30
const MAX_METRICS_QUERIES = 4
const MAX_TRACE_CANDIDATES = 5
const TRACE_SAMPLE_MESSAGE_LENGTH = 120
/**
 * Facets the baseline comparison attributes the change to. Passed to
 * runComparison explicitly so the facets re-fetched for the target window can
 * never drift from the ones the comparison asks the baseline window for.
 */
const COMPARISON_FACETS = ['service']
/**
 * Facet values fetched for the comparison's target window. Must match the cap
 * runComparison uses for the baseline window (see PrecomputedTargetWindow):
 * the investigation's own breakdowns stop at DEFAULT_CAPS.maxFacetValues, and
 * feeding those in would report the baseline's tail as newly appeared.
 */
const COMPARISON_FACET_VALUES = 100

/**
 * Runs the full investigation pipeline: one page of logs, a status-grouped
 * timeseries for the timeline chart, per-facet total counts, and — unless
 * this is a load-more page — events, metric series and a baseline comparison
 * for the same window.
 */
export async function runInvestigation(
  client: DatadogLogsClient,
  params: InvestigationParams
): Promise<InvestigationOutput> {
  const config = getServerConfig()
  const caps: NormalizeCaps = { ...DEFAULT_CAPS, maxRows: config.maxRows }
  const limit = Math.min(params.limit ?? config.maxRows, HARD_MAX_ROWS)

  const resolved = resolveRange(params.from, params.to)
  const interval = pickInterval(resolved.toMs - resolved.fromMs)

  const facets = [...BASE_FACETS]
  if (params.groupBy && !facets.includes(params.groupBy)) {
    facets.push(params.groupBy)
  }

  const base = { query: params.query, from: params.from, to: params.to }

  // Keep these calls sequential. A full investigation issues several Datadog
  // API requests (up to ~10 with events and metrics enabled); firing them all
  // at once makes small Datadog orgs hit 429 quickly.
  const search = await client.searchLogs({ ...base, limit, cursor: params.cursor, sort: '-timestamp' })
  const timeseriesBuckets = await client.aggregateTimeseriesByStatus({ ...base, interval: interval.label })
  const facetBuckets: RawAggregateBucket[][] = []
  for (const facet of facets) {
    facetBuckets.push(await client.aggregateByFacet({ ...base, facet }))
  }

  // Cross-source fetches degrade per-source: a missing scope (events_read,
  // timeseries_query) must never fail the whole investigation. Load-more
  // pages skip them entirely — the window is frozen, so the data is unchanged
  // and session-ops carries the previous result forward.
  const notices: string[] = []
  let events: EventMarker[] | undefined
  if (params.includeEvents !== false && !params.cursor) {
    try {
      const rawEvents = await client.searchEvents({
        query: params.eventsQuery ?? '*',
        from: params.from,
        to: params.to,
        limit: MAX_EVENTS,
      })
      events = rawEvents
        .map((event) => normalizeEventMarker(event, caps))
        .filter((event) => event.time !== '')
        .sort((a, b) => a.time.localeCompare(b.time))
    } catch (error) {
      notices.push(`Events unavailable: ${describeDatadogError(error, 'events_read')}`)
    }
  }

  let metrics: MetricSeries[] | undefined
  const metricsQueries = (params.metricsQueries ?? []).slice(0, MAX_METRICS_QUERIES)
  if (metricsQueries.length > 0 && !params.cursor) {
    metrics = []
    for (const metricQuery of metricsQueries) {
      try {
        const raw = await client.queryMetrics({
          query: metricQuery,
          fromSec: Math.floor(resolved.fromMs / 1000),
          toSec: Math.floor(resolved.toMs / 1000),
        })
        metrics.push(...normalizeMetricSeries(metricQuery, raw))
      } catch (error) {
        notices.push(`Metric query "${metricQuery}" failed: ${describeDatadogError(error, 'timeseries_query')}`)
      }
    }
  }

  const rawById = new Map<string, RawLog>()
  for (const log of search.logs) {
    if (log.id) {
      rawById.set(log.id, log)
    }
  }

  const facetBreakdowns = facets.map((facet, i) => normalizeFacet(facet, facetBuckets[i], caps))
  const statusFacet = facetBreakdowns.find((f) => f.facet === 'status')
  const totalCount = statusFacet
    ? statusFacet.values.reduce((sum, v) => sum + v.count, 0) + (statusFacet.otherCount ?? 0)
    : search.logs.length

  const rows = search.logs.map((log) => normalizeLogRow(log, caps))
  const traceCandidates = extractTraceCandidates(rows)
  const timeline = normalizeTimeline(timeseriesBuckets, caps)

  // A baseline comparison runs only when the caller asked for one, so an
  // investigation that did not issues exactly the requests it always did.
  // Load-more pages skip it for the same reason events and metrics are
  // skipped: the window is frozen and session-ops carries the previous
  // comparison forward.
  let comparison: ComparisonResult | undefined
  const wantsComparison = Boolean(params.baseline || params.baselineFrom || params.baselineTo)
  if (wantsComparison && !params.cursor) {
    let comparisonFacets: FacetBreakdown[] | undefined
    try {
      const breakdowns: FacetBreakdown[] = []
      for (const facet of COMPARISON_FACETS) {
        const buckets = await client.aggregateByFacet({ ...base, facet, limit: COMPARISON_FACET_VALUES })
        breakdowns.push(normalizeFacet(facet, buckets, { ...caps, maxFacetValues: COMPARISON_FACET_VALUES }))
      }
      comparisonFacets = breakdowns
    } catch (error) {
      // Without them the comparison still reports volume, patterns and onset;
      // it adds its own notice for the facets it could not compare.
      notices.push(`Comparison facet attribution unavailable: ${describeDatadogError(error)}`)
    }
    try {
      comparison = await runComparison(client, {
        query: params.query,
        from: params.from,
        to: params.to,
        ...(params.baseline !== undefined ? { baseline: params.baseline } : {}),
        ...(params.baselineFrom !== undefined ? { baselineFrom: params.baselineFrom } : {}),
        ...(params.baselineTo !== undefined ? { baselineTo: params.baselineTo } : {}),
        // scope '' = no extra filter on either window's pattern sample. The
        // rows handed over below were fetched with the investigation's query
        // alone, so the default 'status:error' would diff an all-status target
        // sample against an errors-only baseline sample.
        scope: '',
        facets: COMPARISON_FACETS,
        // Same page size on both sides, so the sampled templates of the two
        // windows are drawn at the same depth.
        sampleLimit: limit,
        // With no target rows to reuse there is nothing to diff against: every
        // baseline template would read as "gone". Skipping also saves the
        // baseline's sample request.
        includePatterns: rows.length > 0,
        precomputedTarget: {
          range: resolved,
          interval,
          // Statuses are a closed set well under maxFacetValues, so this
          // breakdown carries the whole window total despite the lower cap.
          statusFacet: statusFacet ?? { facet: 'status', values: [] },
          timeline,
          rows,
          rowsTruncated: search.logs.length >= limit,
          ...(events !== undefined ? { events } : {}),
          ...(comparisonFacets !== undefined ? { facets: comparisonFacets } : {}),
        },
      })
    } catch (error) {
      // A failed comparison is one missing section, never a failed investigation.
      notices.push(`Baseline comparison unavailable: ${describeDatadogError(error)}`)
    }
  }

  // Cross-source fields are spread conditionally so an investigation that
  // doesn't use them produces the exact same result shape as before.
  const result: InvestigationResult = {
    params: { ...params, limit },
    totalCount,
    timeline,
    interval: interval.label,
    facets: facetBreakdowns,
    rows,
    ...(search.nextCursor ? { nextCursor: search.nextCursor } : {}),
    fetchedAt: new Date().toISOString(),
    resolvedRange: { fromMs: resolved.fromMs, toMs: resolved.toMs },
    ...(events !== undefined ? { events } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(traceCandidates.length > 0 ? { traceCandidates } : {}),
    ...(comparison ? { comparison } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  }

  return { result, rawById }
}

/**
 * Groups stored rows by the trace id extracted from their attributes and
 * returns the most error-heavy traces — pivot candidates for
 * datadog_get_trace. Local computation only; no API calls.
 */
export function extractTraceCandidates(rows: LogRow[], limit = MAX_TRACE_CANDIDATES): TraceCandidate[] {
  const byTrace = new Map<string, { rows: LogRow[]; errorRows: LogRow[] }>()
  for (const row of rows) {
    if (!row.traceId) {
      continue
    }
    const entry = byTrace.get(row.traceId) ?? { rows: [], errorRows: [] }
    entry.rows.push(row)
    if (row.status === 'error') {
      entry.errorRows.push(row)
    }
    byTrace.set(row.traceId, entry)
  }
  const candidates: TraceCandidate[] = []
  for (const [traceId, entry] of byTrace) {
    const services = [...new Set(entry.rows.map((r) => r.service).filter((s): s is string => Boolean(s)))].slice(0, 3)
    const sample = (entry.errorRows[0] ?? entry.rows[0]).message
    const firstSeen = entry.rows.reduce(
      (earliest, row) => (row.timestamp && row.timestamp < earliest ? row.timestamp : earliest),
      entry.rows[0].timestamp
    )
    candidates.push({
      traceId,
      count: entry.rows.length,
      errorCount: entry.errorRows.length,
      firstSeen,
      services,
      ...(sample
        ? {
            sampleMessage:
              sample.length > TRACE_SAMPLE_MESSAGE_LENGTH ? `${sample.slice(0, TRACE_SAMPLE_MESSAGE_LENGTH)}…` : sample,
          }
        : {}),
    })
  }
  return candidates.sort((a, b) => b.errorCount - a.errorCount || b.count - a.count).slice(0, limit)
}
