import type {
  ComparisonParams,
  ComparisonResult,
  ComparisonWindow,
  EventMarker,
  FacetAttribution,
  FacetBreakdown,
  LogRow,
  OnsetDetection,
  PatternDiff,
  TimelineBucket,
} from '@kajidog/investigation-shared'
import {
  attributeFacets,
  compareVolume,
  correlateOnsetEvents,
  detectOnset,
  diffPatterns,
  summarizeWindow,
} from '../analysis/comparison.js'
import { getServerConfig, HARD_MAX_ROWS } from '../config.js'
import type { DatadogLogsClient } from './client.js'
import { describeDatadogError } from './client.js'
import {
  DEFAULT_CAPS,
  type NormalizeCaps,
  normalizeEventMarker,
  normalizeFacet,
  normalizeLogRow,
  normalizeTimeline,
} from './normalize.js'
import type { ResolvedRange } from './time.js'
import {
  effectiveBaselineMode,
  parseBaselineSpec,
  pickInterval,
  rangesOverlap,
  resolveBaselineRange,
  resolveRange,
} from './time.js'

/** Extra filter applied to the pattern samples when the caller supplies none. */
const DEFAULT_SCOPE = 'status:error'
const DEFAULT_FACETS = ['service']
const MAX_FACETS = 3
/**
 * Facet values fetched per window. Deliberately far above the 15 of DEFAULT_CAPS:
 * a value inside the target's top 15 but below the baseline's cut would come back
 * as baselineCount 0 and be reported as newly appeared.
 */
const MAX_FACET_VALUES = 100
/** Statuses are a closed set (<=10 values), so this never truncates the window total. */
const STATUS_FACET_LIMIT = 20
const MAX_EVENTS = 30

/** Facet/timeline caps shared by both windows; only the facet cap differs from the defaults. */
const WINDOW_CAPS: NormalizeCaps = { ...DEFAULT_CAPS, maxFacetValues: MAX_FACET_VALUES }

/**
 * A target window that has already been fetched (by an investigation), reused
 * verbatim so a comparison costs baseline-side requests only.
 *
 * Two things the producer owns: `rows` must already match the comparison's
 * `scope` (pass `scope: ''` when they are unscoped, otherwise the sampled
 * templates of the two windows are drawn from different populations), and
 * `facets` must be normalized with the same {@link MAX_FACET_VALUES} cap used
 * here — a breakdown cut at 15 values would misreport the baseline's tail as
 * newly appeared. Facets that are absent here are skipped with a notice rather
 * than re-fetched, which is what keeps the target side at zero API calls.
 */
export interface PrecomputedTargetWindow {
  range: ResolvedRange
  interval: { label: string; ms: number }
  statusFacet: FacetBreakdown
  timeline: TimelineBucket[]
  rows: LogRow[]
  rowsTruncated: boolean
  events?: EventMarker[]
  facets?: FacetBreakdown[]
}

export interface RunComparisonOptions {
  query: string
  from: string
  to: string
  baseline?: string
  baselineFrom?: string
  baselineTo?: string
  /** Extra filter for the pattern samples. Default 'status:error'; '' disables. */
  scope?: string
  facets?: string[]
  sampleLimit?: number
  includeEvents?: boolean
  includePatterns?: boolean
  /** Reuse an investigation's already-fetched target window: zero target-side calls. */
  precomputedTarget?: PrecomputedTargetWindow
  nowMs?: number
}

/**
 * Combines a query with the sample scope.
 * The original query is parenthesized so an `OR` in it cannot swallow the scope.
 */
export function scopedQuery(query: string, scope: string | undefined): string {
  const q = query.trim()
  if (!scope) {
    return q || '*'
  }
  if (!q || q === '*') {
    return scope
  }
  return `(${q}) ${scope}`
}

type WindowLabel = 'target' | 'baseline'

interface FetchedWindow {
  statusFacet: FacetBreakdown
  timeline: TimelineBucket[]
  facets: Map<string, FacetBreakdown>
  rows: LogRow[]
  rowsTruncated: boolean
  /** False when the sample was skipped or failed — a one-sided diff is worse than none. */
  rowsFetched: boolean
  events?: EventMarker[]
}

interface FetchWindowOptions {
  label: WindowLabel
  query: string
  sampleQuery: string
  from: string
  to: string
  interval: string
  facets: string[]
  includePatterns: boolean
  includeEvents: boolean
  limit: number
  notices: string[]
}

/**
 * Fetches one window: status totals, timeline, per-facet totals, a page of
 * sampled rows and (target only) events.
 *
 * Keep these calls sequential. A comparison issues up to ~13 Datadog API
 * requests across both windows; firing them at once makes small Datadog orgs
 * hit 429 quickly — the same reason runInvestigation stays serial.
 *
 * Every source except the status aggregation degrades to a notice: a missing
 * facet or an unreadable sample costs one section, while a missing window total
 * leaves nothing to compare and is left to throw.
 */
async function fetchWindow(client: DatadogLogsClient, options: FetchWindowOptions): Promise<FetchedWindow> {
  const base = { query: options.query, from: options.from, to: options.to }

  const statusBuckets = await client.aggregateByFacet({ ...base, facet: 'status', limit: STATUS_FACET_LIMIT })
  const statusFacet = normalizeFacet('status', statusBuckets, WINDOW_CAPS)

  let timeline: TimelineBucket[] = []
  try {
    const timelineBuckets = await client.aggregateTimeseriesByStatus({ ...base, interval: options.interval })
    timeline = normalizeTimeline(timelineBuckets, WINDOW_CAPS)
  } catch (error) {
    options.notices.push(`Timeline unavailable for the ${options.label} window: ${describeDatadogError(error)}`)
  }

  const facets = new Map<string, FacetBreakdown>()
  for (const facet of options.facets) {
    try {
      const buckets = await client.aggregateByFacet({ ...base, facet, limit: MAX_FACET_VALUES })
      facets.set(facet, normalizeFacet(facet, buckets, WINDOW_CAPS))
    } catch (error) {
      options.notices.push(
        `Facet "${facet}" unavailable for the ${options.label} window: ${describeDatadogError(error)}`
      )
    }
  }

  let rows: LogRow[] = []
  let rowsTruncated = false
  let rowsFetched = false
  if (options.includePatterns) {
    try {
      const search = await client.searchLogs({
        query: options.sampleQuery,
        from: options.from,
        to: options.to,
        limit: options.limit,
        sort: '-timestamp',
      })
      // Both windows normalize with the same caps: a differing maxMessageLength
      // would produce different templates for the same message.
      rows = search.logs.map((log) => normalizeLogRow(log, DEFAULT_CAPS))
      rowsTruncated = search.logs.length >= options.limit
      rowsFetched = true
    } catch (error) {
      options.notices.push(
        `Pattern samples unavailable for the ${options.label} window: ${describeDatadogError(error)}`
      )
    }
  }

  let events: EventMarker[] | undefined
  if (options.includeEvents) {
    try {
      const rawEvents = await client.searchEvents({ query: '*', from: options.from, to: options.to, limit: MAX_EVENTS })
      events = rawEvents
        .map((event) => normalizeEventMarker(event, WINDOW_CAPS))
        .filter((event) => event.time !== '')
        .sort((a, b) => a.time.localeCompare(b.time))
    } catch (error) {
      options.notices.push(`Events unavailable: ${describeDatadogError(error, 'events_read')}`)
    }
  }

  return {
    statusFacet,
    timeline,
    facets,
    rows,
    rowsTruncated,
    rowsFetched,
    ...(events !== undefined ? { events } : {}),
  }
}

/** Adapts an already-fetched target window to {@link FetchedWindow} without issuing a single request. */
function reusePrecomputedTarget(
  precomputed: PrecomputedTargetWindow,
  facetNames: string[],
  includePatterns: boolean,
  includeEvents: boolean,
  notices: string[]
): FetchedWindow {
  const supplied = new Map((precomputed.facets ?? []).map((facet) => [facet.facet, facet]))
  const facets = new Map<string, FacetBreakdown>()
  for (const facet of facetNames) {
    const breakdown = supplied.get(facet)
    if (breakdown) {
      facets.set(facet, breakdown)
    } else {
      notices.push(`Facet "${facet}" is not part of the reused target window, so it was not compared.`)
    }
  }
  return {
    statusFacet: precomputed.statusFacet,
    timeline: precomputed.timeline,
    facets,
    rows: includePatterns ? precomputed.rows : [],
    rowsTruncated: includePatterns && precomputed.rowsTruncated,
    // An empty reused sample is not a fetched sample. Reporting it as one would
    // diff nothing against the baseline's templates and label every one of them
    // "gone", which reads as a resolved incident rather than as missing data.
    rowsFetched: includePatterns && precomputed.rows.length > 0,
    ...(includeEvents && precomputed.events !== undefined ? { events: precomputed.events } : {}),
  }
}

/**
 * Measures a target window against a baseline window: volume, message-template
 * diffs, per-facet attribution and where the error rate started departing.
 *
 * The clock is read once and threaded through every resolution step, and both
 * windows are sent to Datadog as absolute ISO instants, so a relative range
 * ("now-1h") cannot drift between the requests that make up one comparison.
 * Both windows share a single bucket interval — otherwise their timelines are
 * not comparable and onset detection is meaningless.
 */
export async function runComparison(
  client: DatadogLogsClient,
  options: RunComparisonOptions
): Promise<ComparisonResult> {
  const config = getServerConfig()
  const nowMs = options.nowMs ?? Date.now()
  const limit = Math.max(1, Math.min(options.sampleLimit ?? config.maxRows, HARD_MAX_ROWS))
  const scope = (options.scope ?? DEFAULT_SCOPE).trim()
  const includePatterns = options.includePatterns !== false
  const includeEvents = options.includeEvents !== false
  const facetNames = [
    ...new Set((options.facets ?? DEFAULT_FACETS).map((facet) => facet.trim()).filter(Boolean)),
  ].slice(0, MAX_FACETS)

  const target = options.precomputedTarget?.range ?? resolveRange(options.from, options.to, nowMs)
  const spec = parseBaselineSpec(options.baseline)
  const explicit = { from: options.baselineFrom, to: options.baselineTo }
  const baseline = resolveBaselineRange(target, spec, explicit, nowMs)
  // Derived by the same helper the resolver uses, so the echoed mode can never
  // disagree with the window that was actually resolved.
  const mode = effectiveBaselineMode(spec, explicit)
  const interval = options.precomputedTarget?.interval ?? pickInterval(target.toMs - target.fromMs)

  const notices: string[] = []
  if (rangesOverlap(target, baseline)) {
    notices.push(
      'The baseline window overlaps the target window, so part of the target is measured against itself ' +
        'and the reported delta is partly self-referential.'
    )
  }

  const sampleQuery = scopedQuery(options.query, scope)
  const targetWindow = options.precomputedTarget
    ? reusePrecomputedTarget(options.precomputedTarget, facetNames, includePatterns, includeEvents, notices)
    : await fetchWindow(client, {
        label: 'target',
        query: options.query,
        sampleQuery,
        from: new Date(target.fromMs).toISOString(),
        to: new Date(target.toMs).toISOString(),
        interval: interval.label,
        facets: facetNames,
        includePatterns,
        includeEvents,
        limit,
        notices,
      })

  const baselineWindow = await fetchWindow(client, {
    label: 'baseline',
    query: options.query,
    sampleQuery,
    from: new Date(baseline.fromMs).toISOString(),
    to: new Date(baseline.toMs).toISOString(),
    interval: interval.label,
    // Only facets the target actually has can be attributed; fetching the others
    // would spend a request on a comparison that cannot be made.
    facets: facetNames.filter((facet) => targetWindow.facets.has(facet)),
    // Same reasoning for the sample: with no target rows there is nothing to
    // diff the baseline's templates against, so the request would buy nothing.
    includePatterns: includePatterns && targetWindow.rowsFetched,
    // Events annotate the onset, which sits in the target window by construction.
    includeEvents: false,
    limit,
    notices,
  })

  const targetSummary = summarizeWindow(targetWindow.statusFacet, target.fromMs, target.toMs)
  const baselineSummary = summarizeWindow(baselineWindow.statusFacet, baseline.fromMs, baseline.toMs)
  const volume = compareVolume(targetSummary, baselineSummary)

  const patterns = comparePatterns(targetWindow, baselineWindow, targetSummary, baselineSummary, notices)
  const facets = compareFacets(facetNames, targetWindow, baselineWindow, targetSummary, baselineSummary, notices)
  const onset = detectAndCorrelateOnset(targetWindow, baselineWindow, interval.ms)

  for (const [label, window] of [
    ['target', targetSummary],
    ['baseline', baselineSummary],
  ] as Array<[WindowLabel, ComparisonWindow]>) {
    if (window.lowSample) {
      notices.push(
        `The ${label} window holds only ${window.totalCount} logs, so its ratios are closer to noise than to signal.`
      )
    }
  }

  const params: ComparisonParams = {
    query: options.query,
    ...(scope ? { scope } : {}),
    mode,
    ...(mode === 'shift' && spec.label ? { shift: spec.label } : {}),
    facets: facetNames,
  }

  return {
    params,
    target: targetSummary,
    baseline: baselineSummary,
    interval: interval.label,
    volume,
    ...(patterns.length > 0 ? { patterns } : {}),
    ...(facets.length > 0 ? { facets } : {}),
    ...(onset ? { onset } : {}),
    fetchedAt: new Date(nowMs).toISOString(),
    ...(notices.length > 0 ? { notices } : {}),
  }
}

/**
 * Diffs the two sampled row sets, but only when both samples exist: with one
 * side missing, every template in the other reads as `new` or `gone`.
 *
 * The sampling-bias notice is mandatory whenever a window hit its row cap. The
 * sample is the most recent N of the window, so its templates skew towards the
 * end of the window — an unflagged skewed comparison is worse than no
 * comparison at all.
 */
function comparePatterns(
  targetWindow: FetchedWindow,
  baselineWindow: FetchedWindow,
  targetSummary: ComparisonWindow,
  baselineSummary: ComparisonWindow,
  notices: string[]
): PatternDiff[] {
  if (!targetWindow.rowsFetched || !baselineWindow.rowsFetched) {
    return []
  }
  for (const [label, window, summary] of [
    ['target', targetWindow, targetSummary],
    ['baseline', baselineWindow, baselineSummary],
  ] as Array<[WindowLabel, FetchedWindow, ComparisonWindow]>) {
    if (window.rowsTruncated) {
      notices.push(
        `Pattern comparison sampled the most recent ${window.rows.length} of ~${summary.totalCount} logs in the ` +
          `${label} window; its templates may skew toward the end of the window.`
      )
    }
  }

  const diff = diffPatterns(
    targetWindow.rows,
    baselineWindow.rows,
    targetSummary.totalCount,
    baselineSummary.totalCount
  )
  if (diff.truncated) {
    notices.push(
      'The template set may be incomplete: a window hit the pattern clustering limit, so a template in the ' +
        'untracked tail can be misreported as new.'
    )
  }
  // targetRowIds is deliberately left unset: only the caller knows whether these
  // rows are session-backed and their ids resolvable.
  return diff.diffs
}

/** Attributes the change to each facet's values, flagging any window the facet does not fully cover. */
function compareFacets(
  facetNames: string[],
  targetWindow: FetchedWindow,
  baselineWindow: FetchedWindow,
  targetSummary: ComparisonWindow,
  baselineSummary: ComparisonWindow,
  notices: string[]
): FacetAttribution[] {
  const attributions: FacetAttribution[] = []
  for (const facet of facetNames) {
    const targetFacet = targetWindow.facets.get(facet)
    const baselineFacet = baselineWindow.facets.get(facet)
    if (!targetFacet || !baselineFacet) {
      continue
    }
    const attribution = attributeFacets(
      facet,
      targetFacet,
      baselineFacet,
      targetSummary.totalCount,
      baselineSummary.totalCount
    )
    for (const [label, covered, total] of [
      ['target', attribution.targetCovered, attribution.targetTotal],
      ['baseline', attribution.baselineCovered, attribution.baselineTotal],
    ] as Array<[WindowLabel, number, number]>) {
      if (covered < total) {
        notices.push(
          `Facet "${facet}" covers ${covered} of ${total} logs in the ${label} window; values past the top ` +
            `${MAX_FACET_VALUES} are excluded.`
        )
      }
    }
    attributions.push(attribution)
  }
  return attributions
}

/** Finds the onset and, when the target window carried events, the ones that bracket it. */
function detectAndCorrelateOnset(
  targetWindow: FetchedWindow,
  baselineWindow: FetchedWindow,
  intervalMs: number
): OnsetDetection | undefined {
  const onset = detectOnset(targetWindow.timeline, baselineWindow.timeline)
  if (!onset) {
    return undefined
  }
  const events = targetWindow.events
  if (!events || events.length === 0) {
    return onset
  }
  const onsetMs = Date.parse(onset.time)
  if (Number.isNaN(onsetMs)) {
    return onset
  }
  return { ...onset, ...correlateOnsetEvents(onsetMs, events, intervalMs) }
}
