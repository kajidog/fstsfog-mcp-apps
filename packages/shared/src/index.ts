/**
 * Wire types shared between the MCP server (apps/mcp-datadog-logs) and the
 * MCP Apps UI (packages/investigator-ui). Type-only — no runtime code.
 */

export type LogStatus = 'error' | 'warn' | 'info' | 'debug' | string

export interface InvestigationParams {
  /** Datadog logs search query, e.g. "service:payments status:error" */
  query: string
  /** Datadog time syntax ("now-4h") or ISO 8601 */
  from: string
  to: string
  /** Optional extra facet to break down by (e.g. "@http.status_code") */
  groupBy?: string
  /** Max log rows to return (server clamps to its own limit) */
  limit?: number
  /** Pagination cursor for load-more */
  cursor?: string
  /** Human title for the investigation / report */
  title?: string
  /** Fetch Datadog events (deploys, alerts) for the same window. Default true. */
  includeEvents?: boolean
  /** Events search query; defaults to all events in the window */
  eventsQuery?: string
  /** Metric queries to fetch alongside logs (classic query strings, server caps the count) */
  metricsQueries?: string[]
  /** Baseline window selector: "previous" (default), "1d", "1w", a shift like "4h" */
  baseline?: string
  /** Explicit baseline start (wins over `baseline`); when `baselineTo` is omitted the window matches the target's length */
  baselineFrom?: string
  /** Explicit baseline end (Datadog time syntax or ISO 8601) */
  baselineTo?: string
}

export interface LogRow {
  id: string
  /** ISO 8601 timestamp */
  timestamp: string
  status: LogStatus
  service?: string
  host?: string
  /** Message, possibly truncated (see messageTruncated) */
  message: string
  messageTruncated?: boolean
  /** Capped list of tags */
  tags?: string[]
  /** APM trace id extracted from the log's attributes, for pivoting to datadog_get_trace */
  traceId?: string
}

export interface TimelineBucket {
  /** Bucket start, ISO 8601 */
  time: string
  /** Counts keyed by status (error/warn/info/debug/...) */
  counts: Record<string, number>
}

export interface FacetValueCount {
  value: string
  count: number
}

export interface FacetBreakdown {
  /** Facet name, e.g. "service", "status", "host", or custom groupBy */
  facet: string
  values: FacetValueCount[]
  /** Count rolled into "other" beyond the returned values */
  otherCount?: number
}

export type EventMarkerKind = 'deploy' | 'alert' | 'other'

/** A Datadog event (deploy, monitor alert, config change) overlaid on the investigation timeline. */
export interface EventMarker {
  id: string
  /** ISO 8601 */
  time: string
  kind: EventMarkerKind
  /** Event title, truncated */
  title: string
  /** Event status: info/warning/error */
  status?: string
  /** Event source, e.g. "github", "alert" */
  source?: string
  /** Capped list of tags */
  tags?: string[]
}

export interface MetricPoint {
  /** ISO 8601 bucket time */
  time: string
  /** null = no data in the bucket (renders as a gap) */
  value: number | null
}

/** One timeseries returned by a metric query, downsampled for transport. */
export interface MetricSeries {
  /** The metricsQueries entry that produced this series */
  query: string
  /** Metric expression, e.g. "avg:system.cpu.user" */
  metric: string
  /** Series scope, e.g. "service:web,host:i-0a1b" */
  scope?: string
  /** Unit short name, e.g. "%" or "ms" */
  unit?: string
  /** Downsampled points (server caps the count) */
  points: MetricPoint[]
  /** Stats computed over the raw (pre-downsample) values */
  stats: { min: number; max: number; avg: number; last: number | null }
}

/** An APM trace id seen on stored log rows — a pivot candidate for datadog_get_trace. */
export interface TraceCandidate {
  traceId: string
  /** Stored rows carrying this trace id */
  count: number
  errorCount: number
  /** ISO 8601 of the earliest row */
  firstSeen: string
  /** Up to a few distinct services seen on those rows */
  services: string[]
  /** First error (or first) message, truncated */
  sampleMessage?: string
}

export interface LogPattern {
  /** Normalized message template; variable parts replaced with "<*>" */
  template: string
  count: number
  /** count / analyzed row count, 0–1 */
  ratio: number
  /** First raw message that produced this template */
  example: string
  /** Ids of the analyzed rows belonging to this pattern (client-side filtering) */
  rowIds: string[]
}

/** How the baseline window was derived */
export type BaselineMode = 'previous' | 'shift' | 'custom'

/** Aggregates for one side of a two-window comparison */
export interface ComparisonWindow {
  /** Window start (epoch ms) */
  fromMs: number
  /** Window end (epoch ms) */
  toMs: number
  /** Total logs matching the comparison query in this window */
  totalCount: number
  /** Counts keyed by status */
  statusCounts: Record<string, number>
  /** errors / totalCount, 0–1; 0 when totalCount is 0 */
  errorRate: number
  /** Below the small-sample floor — ratios from this window are noise */
  lowSample?: boolean
}

/** Count delta between the target and baseline windows */
export interface VolumeDelta {
  targetCount: number
  baselineCount: number
  /** targetCount - baselineCount */
  delta: number
  /** targetCount / baselineCount; null when baselineCount is 0 (never Infinity) */
  ratio: number | null
}

export interface VolumeComparison {
  /** Delta across the whole window */
  total: VolumeDelta
  /** Union of statuses seen in either window; a status missing from one side counts as 0 */
  byStatus: Array<VolumeDelta & { status: string }>
  /** target.errorRate - baseline.errorRate, in rate points (-1..1) */
  errorRateDelta: number
}

/** Kind of pattern change: appeared / rose / fell / disappeared */
export type PatternDiffKind = 'new' | 'spiking' | 'dropping' | 'gone'

export interface PatternDiff {
  /** Normalized template (same clustering as LogPattern.template) */
  template: string
  kind: PatternDiffKind
  /** Share of each window's sampled rows, 0–1 — the only comparable quantity */
  targetRatio: number
  baselineRatio: number
  /** Raw occurrences inside the sample (not the window total) */
  targetSampleCount: number
  baselineSampleCount: number
  /** Ratio extrapolated to the window total */
  estimatedTargetCount: number
  estimatedBaselineCount: number
  /** targetRatio / baselineRatio; null when baselineRatio is 0 */
  lift: number | null
  /** A raw message that produced this template */
  example: string
  /**
   * Ids of TARGET-window rows in this pattern. Present only when the comparison
   * clustered a session's stored rows. Baseline rows are never stored server-side,
   * so baseline ids are never emitted (_get_log_detail would 404 on them).
   */
  targetRowIds?: string[]
}

/** One facet value, measured by how disproportionately it grew against the baseline */
export interface FacetAttributionValue {
  value: string
  targetCount: number
  baselineCount: number
  /** targetCount / targetCovered, 0–1 */
  targetShare: number
  /** baselineCount / baselineCovered, 0–1 */
  baselineShare: number
  /**
   * targetCount - baselineCount * (targetCovered / baselineCovered): occurrences
   * beyond what a uniform scale-up of the baseline predicts. Positive = this value
   * got disproportionately worse. Sums to ~0 across all values, so a pure traffic
   * surge leaves every value near zero.
   */
  excess: number
  /** targetShare / baselineShare; null when baselineShare is 0 */
  lift: number | null
  /** Absent from the baseline window's fetched values */
  isNew?: boolean
  /** The baseline facet fetch was truncated — baselineCount is a lower bound */
  baselineTruncated?: boolean
}

/** Attribution analysis for one facet dimension */
export interface FacetAttribution {
  /** Facet name, e.g. "service", "@http.status_code" */
  facet: string
  /** Ranked by |excess|, positives first */
  values: FacetAttributionValue[]
  /** Sum of the fetched facet values in each window */
  targetCovered: number
  baselineCovered: number
  /** Window totals from the status aggregation (never truncated) */
  targetTotal: number
  baselineTotal: number
}

/** An event observed near the onset, with how far ahead of it the event landed */
export interface OnsetEvent {
  event: EventMarker
  /** onset time - event time, ms; positive = the event preceded the onset */
  leadTimeMs: number
}

/** Where the error rate starts departing from the baseline and stays there */
export interface OnsetDetection {
  /** Bucket start where the sustained departure begins, ISO 8601 */
  time: string
  /** Position of that bucket in the timeline */
  bucketIndex: number
  /** Error rate at the onset bucket, 0–1 */
  errorRate: number
  /** Mean per-bucket error rate over the baseline window */
  baselineMean: number
  /** Standard deviation of the baseline per-bucket error rate */
  baselineStdev: number
  /** max(baselineMean + K*stdev, baselineMean + absolute floor) */
  threshold: number
  /** Consecutive qualifying buckets from the onset */
  sustainedBuckets: number
  /** (errorRate - baselineMean) / baselineStdev; null when stdev is 0 */
  sigmas: number | null
  /** Nearest event before the onset */
  precedingEvent?: OnsetEvent
  /** Other events near the onset, chronological */
  nearbyEvents?: OnsetEvent[]
}

/** The comparison's inputs, carried on the result so a run can be reproduced */
export interface ComparisonParams {
  /** Datadog logs query both windows are measured with */
  query: string
  /** Extra filter applied to the pattern/facet samples, e.g. "status:error" */
  scope?: string
  mode: BaselineMode
  /** Shift applied for mode "shift", e.g. "1d" */
  shift?: string
  /** Facets compared for attribution */
  facets: string[]
}

export interface ComparisonResult {
  params: ComparisonParams
  /** The window under investigation */
  target: ComparisonWindow
  /** The window it is measured against */
  baseline: ComparisonWindow
  /** Timeline bucket interval used for onset detection, e.g. "5m" */
  interval: string
  volume: VolumeComparison
  /** Message template diffs (from clustering the sampled rows) */
  patterns?: PatternDiff[]
  /** Per-facet attribution */
  facets?: FacetAttribution[]
  /** Where the degradation started */
  onset?: OnsetDetection
  /** ISO 8601 — when this comparison was produced */
  fetchedAt: string
  /** Degraded fetches, truncation warnings, small-sample warnings */
  notices?: string[]
}

export interface InvestigationResult {
  params: InvestigationParams
  /** Approximate total matching logs (from aggregation) */
  totalCount: number
  timeline: TimelineBucket[]
  /** Interval used for the timeline, e.g. "5m" */
  interval: string
  facets: FacetBreakdown[]
  rows: LogRow[]
  /** Cursor to fetch the next page of rows, if any */
  nextCursor?: string
  /** ISO 8601 — when this result was produced */
  fetchedAt: string
  /** AI-authored findings/notes for this investigation (plain text, may contain line breaks) */
  findings?: string
  /** Message templates clustered from the fetched rows (not the full match set) */
  patterns?: LogPattern[]
  /** Resolved absolute time range (epoch ms) for display */
  resolvedRange: { fromMs: number; toMs: number }
  /** Datadog events in the window (deploys, alerts), chronological */
  events?: EventMarker[]
  /** Metric series fetched via params.metricsQueries */
  metrics?: MetricSeries[]
  /** Trace ids extracted from stored rows, error-heavy first */
  traceCandidates?: TraceCandidate[]
  /** Human-readable notes about degraded cross-source fetches (missing scopes etc.) */
  notices?: string[]
  /** Baseline-window comparison, present only when the investigation requested one */
  comparison?: ComparisonResult
}

/** Payload of _get_view_state / _run_investigation when the view is unknown */
export interface ViewNotFound {
  notFound: true
}

export interface ExportResult {
  ok: boolean
  path?: string
  /** True when the server successfully launched, or likely launched, the system browser. */
  opened?: boolean
  /** HTML export succeeded, but launching the browser failed. */
  openError?: string
  error?: string
}

/** Regex contract: tool result text contains `viewUUID: <uuid>` */
export const VIEW_UUID_PATTERN = 'viewUUID:\\s*([0-9a-fA-F-]{36})'
