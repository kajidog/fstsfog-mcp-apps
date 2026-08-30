import type {
  ComparisonWindow,
  EventMarker,
  FacetAttribution,
  FacetAttributionValue,
  FacetBreakdown,
  LogPattern,
  LogRow,
  OnsetDetection,
  OnsetEvent,
  PatternDiff,
  PatternDiffKind,
  TimelineBucket,
  VolumeComparison,
  VolumeDelta,
} from '@kajidog/investigation-shared'
import { extractLogPatterns } from './patterns.js'

/**
 * Pure statistics for the target-vs-baseline comparison. Everything this module
 * needs arrives as arguments: no Datadog client, no clock, no environment, no
 * I/O — which is what makes the thresholds below testable in isolation.
 *
 * Two rules run through the whole file:
 *  - the two windows are sampled independently, so only *ratios* (share of a
 *    window) are comparable, never raw counts;
 *  - a ratio with a zero denominator is reported as `null`, never as Infinity
 *    or NaN.
 */

/** Below this many logs, a window's ratios are noise rather than signal. */
const MIN_WINDOW_SAMPLE = 20
/** Sample occurrences a template needs before a diff is worth reporting. */
const MIN_PATTERN_COUNT = 3
/** Ratio-to-ratio factor that counts as a spike (and, inverted, as a drop). */
const SPIKE_LIFT = 2.0
const MAX_PATTERN_DIFFS = 15
const MAX_ATTRIBUTION_VALUES = 10
/** Sigma multiplier for the onset threshold. */
const ONSET_K = 3
/** Absolute floor under the sigma test: 2 rate points. */
const ONSET_MIN_ABS_RISE = 0.02
const ONSET_SUSTAIN_BUCKETS = 3
/** Buckets thinner than this cannot be the onset and are left out of the baseline stats. */
const ONSET_MIN_BUCKET_TOTAL = 10
const ONSET_EVENT_WINDOW_MS = 30 * 60_000
const ONSET_EVENT_WINDOW_MAX_MS = 2 * 60 * 60_000
const ONSET_NEARBY_EVENT_LIMIT = 3
/** maxPatterns handed to extractLogPatterns for each window. */
const PATTERN_CLUSTER_LIMIT = 100

/** targetCount / baselineCount, or null when the baseline is zero (never Infinity/NaN). */
function safeRatio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

/**
 * Rolls a window's status facet into the aggregates the comparison is built on.
 * `otherCount` is part of the window total but not of `statusCounts`, so an
 * unknown status still contributes to the denominator of `errorRate`.
 */
export function summarizeWindow(statusFacet: FacetBreakdown, fromMs: number, toMs: number): ComparisonWindow {
  const statusCounts: Record<string, number> = {}
  let totalCount = statusFacet.otherCount ?? 0
  for (const entry of statusFacet.values) {
    statusCounts[entry.value] = (statusCounts[entry.value] ?? 0) + entry.count
    totalCount += entry.count
  }
  const errorRate = (statusCounts.error ?? 0) / Math.max(totalCount, 1)
  return {
    fromMs,
    toMs,
    totalCount,
    statusCounts,
    errorRate,
    ...(totalCount < MIN_WINDOW_SAMPLE ? { lowSample: true } : {}),
  }
}

/**
 * Volume deltas between the two windows.
 *
 * `errorRateDelta` is the headline number precisely because it is immune to
 * traffic scale: if traffic triples and errors triple with it, every count
 * ratio reads 3x while the error rate is unchanged — that is a busy system,
 * not an incident.
 */
export function compareVolume(target: ComparisonWindow, baseline: ComparisonWindow): VolumeComparison {
  const total: VolumeDelta = {
    targetCount: target.totalCount,
    baselineCount: baseline.totalCount,
    delta: target.totalCount - baseline.totalCount,
    ratio: safeRatio(target.totalCount, baseline.totalCount),
  }

  const statuses = new Set([...Object.keys(target.statusCounts), ...Object.keys(baseline.statusCounts)])
  const byStatus = [...statuses]
    .map((status) => {
      const targetCount = target.statusCounts[status] ?? 0
      const baselineCount = baseline.statusCounts[status] ?? 0
      return {
        status,
        targetCount,
        baselineCount,
        delta: targetCount - baselineCount,
        ratio: safeRatio(targetCount, baselineCount),
      }
    })
    // Loudest status in the target window first, so the summary reads sensibly.
    .sort(
      (a, b) => b.targetCount - a.targetCount || b.baselineCount - a.baselineCount || a.status.localeCompare(b.status)
    )

  return { total, byStatus, errorRateDelta: target.errorRate - baseline.errorRate }
}

export interface DiffPatternsResult {
  diffs: PatternDiff[]
  targetAnalyzed: number
  baselineAnalyzed: number
  /** Either window hit PATTERN_CLUSTER_LIMIT — the template set may be incomplete */
  truncated: boolean
}

/**
 * Counts rows the way extractLogPatterns does: rows whose trimmed message is
 * empty are skipped there, and its `ratio` is count/analyzed against that
 * filtered count. Using rows.length instead would silently disagree with the
 * ratios we then compare.
 */
function countAnalyzed(rows: LogRow[]): number {
  let analyzed = 0
  for (const row of rows) {
    if (row.message.trim()) {
      analyzed += 1
    }
  }
  return analyzed
}

function indexPatterns(patterns: LogPattern[]): Map<string, LogPattern> {
  const index = new Map<string, LogPattern>()
  for (const pattern of patterns) {
    index.set(pattern.template, pattern)
  }
  return index
}

/** Report order: new first, then spiking, dropping and gone. */
const KIND_RANK: Record<PatternDiffKind, number> = { new: 0, spiking: 1, dropping: 2, gone: 3 }

/**
 * Diffs the message templates of the two sampled row sets.
 *
 * Comparison is on `ratio` (share of the window's own sample), never on raw
 * counts: the samples are drawn independently and their sizes routinely differ
 * by 5x, so a count-based diff would call every template in the larger sample a
 * spike.
 *
 * `targetRowIds` is deliberately left unset — only the caller knows whether the
 * clustered rows are session-backed, and baseline rows never are.
 */
export function diffPatterns(
  targetRows: LogRow[],
  baselineRows: LogRow[],
  targetTotal: number,
  baselineTotal: number
): DiffPatternsResult {
  const targetPatterns = extractLogPatterns(targetRows, { maxPatterns: PATTERN_CLUSTER_LIMIT })
  const baselinePatterns = extractLogPatterns(baselineRows, { maxPatterns: PATTERN_CLUSTER_LIMIT })
  const targetIndex = indexPatterns(targetPatterns)
  const baselineIndex = indexPatterns(baselinePatterns)

  const diffs: PatternDiff[] = []
  for (const template of new Set([...targetIndex.keys(), ...baselineIndex.keys()])) {
    const targetPattern = targetIndex.get(template)
    const baselinePattern = baselineIndex.get(template)
    const targetRatio = targetPattern?.ratio ?? 0
    const baselineRatio = baselinePattern?.ratio ?? 0
    const targetSampleCount = targetPattern?.count ?? 0
    const baselineSampleCount = baselinePattern?.count ?? 0

    const classified = classify(targetRatio, baselineRatio, targetSampleCount, baselineSampleCount)
    if (!classified) {
      continue
    }
    diffs.push({
      template,
      kind: classified.kind,
      targetRatio,
      baselineRatio,
      targetSampleCount,
      baselineSampleCount,
      estimatedTargetCount: Math.round(targetRatio * targetTotal),
      estimatedBaselineCount: Math.round(baselineRatio * baselineTotal),
      lift: classified.lift,
      example: targetPattern?.example ?? baselinePattern?.example ?? '',
    })
  }

  diffs.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || rankWithinKind(b) - rankWithinKind(a))

  return {
    diffs: diffs.slice(0, MAX_PATTERN_DIFFS),
    targetAnalyzed: countAnalyzed(targetRows),
    baselineAnalyzed: countAnalyzed(baselineRows),
    // Past the limit a template sitting in the baseline's tail would be misread
    // as `new`, so the caller must be able to say the diff is incomplete.
    truncated: targetPatterns.length === PATTERN_CLUSTER_LIMIT || baselinePatterns.length === PATTERN_CLUSTER_LIMIT,
  }
}

function classify(
  targetRatio: number,
  baselineRatio: number,
  targetSampleCount: number,
  baselineSampleCount: number
): { kind: PatternDiffKind; lift: number | null } | undefined {
  if (baselineRatio === 0) {
    // Absent from the baseline sample: only interesting once the target sample
    // has seen it enough times to not be a one-off.
    return targetSampleCount >= MIN_PATTERN_COUNT ? { kind: 'new', lift: null } : undefined
  }
  if (targetRatio === 0) {
    return baselineSampleCount >= MIN_PATTERN_COUNT ? { kind: 'gone', lift: 0 } : undefined
  }
  const lift = targetRatio / baselineRatio
  if (lift >= SPIKE_LIFT && targetSampleCount >= MIN_PATTERN_COUNT) {
    return { kind: 'spiking', lift }
  }
  if (lift <= 1 / SPIKE_LIFT && baselineSampleCount >= MIN_PATTERN_COUNT) {
    return { kind: 'dropping', lift }
  }
  return undefined
}

/** Magnitude of the change within a kind, in estimated window occurrences. */
function rankWithinKind(diff: PatternDiff): number {
  switch (diff.kind) {
    case 'new':
      return diff.estimatedTargetCount
    case 'spiking':
      return diff.estimatedTargetCount - diff.estimatedBaselineCount
    case 'dropping':
      return diff.estimatedBaselineCount - diff.estimatedTargetCount
    case 'gone':
      return diff.estimatedBaselineCount
  }
}

/**
 * Attributes a window's change to the values of one facet.
 *
 * The ranking statistic is `excess`: occurrences beyond what a uniform
 * scale-up of the baseline predicts. Absolute delta is dominated by whichever
 * service is biggest, share-delta is dimensionless and hard to act on, and lift
 * is dominated by small-count noise. `excess` is in units of logs, sums to ~0
 * across values, and collapses to ~0 for every value when traffic simply scales
 * up — so a busy service cannot top the list just for being busy.
 *
 * `targetTotal`/`baselineTotal` come from the status aggregation (never
 * truncated); `covered` is the sum of the facet values actually fetched. When
 * `baselineCovered < baselineTotal` the baseline's tail is invisible, and a
 * value missing from the list may well exist there — such a value is flagged
 * `baselineTruncated`, never `isNew`.
 */
export function attributeFacets(
  facet: string,
  target: FacetBreakdown,
  baseline: FacetBreakdown,
  targetTotal: number,
  baselineTotal: number
): FacetAttribution {
  const targetCounts = toCountMap(target)
  const baselineCounts = toCountMap(baseline)
  const targetCovered = sumCounts(targetCounts)
  const baselineCovered = sumCounts(baselineCounts)
  const baselineWasTruncated = baselineCovered < baselineTotal

  if (targetCovered === 0) {
    // Keep the facet so the caller can render "no matching logs" rather than
    // silently dropping the dimension.
    return { facet, values: [], targetCovered, baselineCovered, targetTotal, baselineTotal }
  }

  // How much bigger the target sample is overall; null when there is nothing to
  // scale from, in which case every target occurrence counts as excess.
  const scale = safeRatio(targetCovered, baselineCovered)

  const values: FacetAttributionValue[] = [...new Set([...targetCounts.keys(), ...baselineCounts.keys()])].map(
    (value) => {
      const targetCount = targetCounts.get(value) ?? 0
      const baselineCount = baselineCounts.get(value) ?? 0
      const targetShare = targetCovered > 0 ? targetCount / targetCovered : 0
      const baselineShare = baselineCovered > 0 ? baselineCount / baselineCovered : 0
      return {
        value,
        targetCount,
        baselineCount,
        targetShare,
        baselineShare,
        excess: scale === null ? targetCount : targetCount - baselineCount * scale,
        lift: safeRatio(targetShare, baselineShare),
        ...(baselineCount === 0 && !baselineWasTruncated ? { isNew: true } : {}),
        ...(baselineCount === 0 && baselineWasTruncated ? { baselineTruncated: true } : {}),
      }
    }
  )

  // Biggest departure from a uniform scale-up first, in either direction; a
  // value that went silent is as actionable as one that blew up. Positive wins
  // an exact tie, then the value name keeps the order deterministic.
  values.sort(
    (a, b) =>
      Math.abs(b.excess) - Math.abs(a.excess) ||
      Math.sign(b.excess) - Math.sign(a.excess) ||
      a.value.localeCompare(b.value)
  )

  return {
    facet,
    values: values.slice(0, MAX_ATTRIBUTION_VALUES),
    targetCovered,
    baselineCovered,
    targetTotal,
    baselineTotal,
  }
}

function toCountMap(breakdown: FacetBreakdown): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of breakdown.values) {
    counts.set(entry.value, (counts.get(entry.value) ?? 0) + entry.count)
  }
  return counts
}

function sumCounts(counts: Map<string, number>): number {
  let sum = 0
  for (const count of counts.values()) {
    sum += count
  }
  return sum
}

function bucketTotal(bucket: TimelineBucket): number {
  let total = 0
  for (const count of Object.values(bucket.counts)) {
    total += count
  }
  return total
}

/** Per-bucket error rate — the metric that absorbs the diurnal traffic curve. */
function bucketErrorRate(bucket: TimelineBucket): number {
  return (bucket.counts.error ?? 0) / Math.max(bucketTotal(bucket), 1)
}

/**
 * Finds where the error rate departs from the baseline and stays there.
 *
 * The metric is the per-bucket error *rate*, not the error count: count-based
 * detection fires on every traffic peak. The threshold combines a sigma test
 * with an absolute floor, and the floor is load-bearing — a rock-steady
 * baseline has sigma ~ 0, where a tenth of a rate point would otherwise read as
 * a 50-sigma event.
 *
 * Returns undefined (rather than a sentinel) when nothing qualifies, so the
 * caller can omit the key entirely.
 */
export function detectOnset(
  targetTimeline: TimelineBucket[],
  baselineTimeline: TimelineBucket[]
): OnsetDetection | undefined {
  if (targetTimeline.length === 0) {
    return undefined
  }

  // Thin buckets are excluded: a 2-of-3 bucket is 67% errors and pure noise.
  const baselineRates = baselineTimeline
    .filter((bucket) => bucketTotal(bucket) >= ONSET_MIN_BUCKET_TOTAL)
    .map(bucketErrorRate)
  if (baselineRates.length < 2) {
    return undefined
  }

  const mean = baselineRates.reduce((sum, rate) => sum + rate, 0) / baselineRates.length
  const variance = baselineRates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / (baselineRates.length - 1)
  const stdev = Math.sqrt(variance)
  const threshold = Math.max(mean + ONSET_K * stdev, mean + ONSET_MIN_ABS_RISE)

  // Require the departure to hold, but never demand more buckets than a short
  // timeline can supply.
  const sustainNeeded = Math.max(1, Math.min(ONSET_SUSTAIN_BUCKETS, Math.floor(targetTimeline.length / 4)))

  for (let index = 0; index < targetTimeline.length; index += 1) {
    const bucket = targetTimeline[index]
    if (bucketTotal(bucket) < ONSET_MIN_BUCKET_TOTAL || bucketErrorRate(bucket) <= threshold) {
      continue
    }
    const sustainedBuckets = countSustained(targetTimeline, index, threshold)
    if (sustainedBuckets < sustainNeeded) {
      continue
    }
    const errorRate = bucketErrorRate(bucket)
    return {
      time: bucket.time,
      bucketIndex: index,
      errorRate,
      baselineMean: mean,
      baselineStdev: stdev,
      threshold,
      sustainedBuckets,
      sigmas: stdev > 0 ? (errorRate - mean) / stdev : null,
    }
  }
  return undefined
}

/**
 * Consecutive buckets above the threshold starting at `start`. Buckets too thin
 * to judge are skipped: they neither count towards the run nor break it, so a
 * quiet minute in the middle of an outage does not hide the outage.
 */
function countSustained(timeline: TimelineBucket[], start: number, threshold: number): number {
  let sustained = 0
  for (let index = start; index < timeline.length; index += 1) {
    const bucket = timeline[index]
    if (bucketTotal(bucket) < ONSET_MIN_BUCKET_TOTAL) {
      continue
    }
    if (bucketErrorRate(bucket) <= threshold) {
      break
    }
    sustained += 1
  }
  return sustained
}

/**
 * Correlates the onset with nearby Datadog events (deploys, alerts).
 *
 * The lookback widens with the bucket interval — a 1h-bucket timeline pins the
 * onset far more loosely than a 1m one — and is capped at two hours so the
 * "preceding" event stays plausibly causal.
 */
export function correlateOnsetEvents(
  onsetMs: number,
  events: EventMarker[],
  intervalMs: number
): { precedingEvent?: OnsetEvent; nearbyEvents?: OnsetEvent[] } {
  const window = Math.min(Math.max(ONSET_EVENT_WINDOW_MS, 2 * intervalMs), ONSET_EVENT_WINDOW_MAX_MS)
  const earliest = onsetMs - window
  // The onset bucket is a span, so an event landing inside it still counts as
  // "at" the onset rather than after it.
  const latest = onsetMs + intervalMs

  const timed: Array<{ event: EventMarker; timeMs: number }> = []
  for (const event of events) {
    const timeMs = Date.parse(event.time)
    if (Number.isNaN(timeMs) || timeMs < earliest || timeMs > latest) {
      continue
    }
    timed.push({ event, timeMs })
  }
  timed.sort((a, b) => a.timeMs - b.timeMs)

  // Latest event strictly before the onset — the most likely trigger.
  const precedingIndex = findLastIndex(timed, (entry) => entry.timeMs < onsetMs)
  // Closest to the onset wins the limited slots, then they are presented in
  // order. Slicing the chronological list instead would keep the *oldest*
  // events in range and drop the deploy that landed on the onset itself.
  const nearby = timed
    .filter((_, index) => index !== precedingIndex)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Math.abs(a.entry.timeMs - onsetMs) - Math.abs(b.entry.timeMs - onsetMs) || a.index - b.index)
    .slice(0, ONSET_NEARBY_EVENT_LIMIT)
    .sort((a, b) => a.index - b.index)
    .map(({ entry }) => toOnsetEvent(entry.event, entry.timeMs, onsetMs))

  return {
    ...(precedingIndex >= 0
      ? { precedingEvent: toOnsetEvent(timed[precedingIndex].event, timed[precedingIndex].timeMs, onsetMs) }
      : {}),
    ...(nearby.length > 0 ? { nearbyEvents: nearby } : {}),
  }
}

function toOnsetEvent(event: EventMarker, timeMs: number, onsetMs: number): OnsetEvent {
  return { event, leadTimeMs: onsetMs - timeMs }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index
    }
  }
  return -1
}
