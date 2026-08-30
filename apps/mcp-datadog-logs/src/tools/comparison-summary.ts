import type {
  ComparisonResult,
  EventMarker,
  FacetAttribution,
  OnsetDetection,
  OnsetEvent,
  PatternDiff,
  VolumeDelta,
} from '@kajidog/investigation-shared'

export interface ComparisonSummaryOptions {
  /** Omit the header line when the caller already printed the query and range. */
  compact?: boolean
}

const MAX_PATTERN_TEMPLATE_LENGTH = 120
const MAX_PATTERNS = 8
const MAX_FACET_VALUES = 5
const MAX_STATUSES = 6
const MAX_NEARBY_EVENTS = 3
const INTERVAL_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/**
 * Compact, model-facing rendering of a target-vs-baseline comparison.
 *
 * Every optional section (patterns, facets, onset, notices) prints nothing at
 * all when it is absent or empty, so an empty array reads exactly like a
 * missing field. Ratios and lifts are `null` on the wire whenever their
 * denominator was 0; they are spelled out here rather than turned into
 * `Infinity` or `NaN`.
 */
export function formatComparisonSummary(result: ComparisonResult, opts: ComparisonSummaryOptions = {}): string {
  return formatComparisonLines(result, opts).join('\n')
}

/** Line-array form, so a caller can splice the comparison into a larger summary. */
export function formatComparisonLines(result: ComparisonResult, opts: ComparisonSummaryOptions = {}): string[] {
  const lines: string[] = []
  if (!opts.compact) {
    lines.push(headerLine(result))
  }
  lines.push(volumeLine(result))
  // Always shown: a large volume ratio with a flat error rate is a traffic
  // surge, not an incident, and only this line separates the two.
  lines.push(errorRateLine(result))

  if (result.onset) {
    lines.push(...onsetLines(result.onset, result))
  }
  const patterns = result.patterns ?? []
  if (patterns.length > 0) {
    lines.push(...patternLines(patterns))
  }
  for (const attribution of result.facets ?? []) {
    lines.push(...facetLines(attribution))
  }
  for (const notice of result.notices ?? []) {
    lines.push(`Note: ${notice}`)
  }
  return lines
}

function headerLine(result: ComparisonResult): string {
  const { params, target, baseline } = result
  const scope = params.scope ? ` (scope ${params.scope})` : ''
  const mode = params.mode === 'shift' && params.shift ? `shift ${params.shift}` : params.mode
  return (
    `Comparison: ${params.query || '*'}${scope} | target ${shortIso(target.fromMs)}→${shortIso(target.toMs)} ` +
    `vs baseline (${mode}) ${shortIso(baseline.fromMs)}→${shortIso(baseline.toMs)} | buckets ${result.interval}`
  )
}

function volumeLine(result: ComparisonResult): string {
  const statuses = result.volume.byStatus
    .filter((status) => status.targetCount > 0 || status.baselineCount > 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, MAX_STATUSES)
    .map((status) => `${status.status} ${deltaText(status)}`)
  return `Volume: ${deltaText(result.volume.total)}${statuses.length > 0 ? ` — ${statuses.join(', ')}` : ''}`
}

function errorRateLine(result: ComparisonResult): string {
  return (
    `Error rate: ${percent(result.target.errorRate)} vs ${percent(result.baseline.errorRate)} ` +
    `(${ratePoints(result.volume.errorRateDelta)})`
  )
}

function onsetLines(onset: OnsetDetection, result: ComparisonResult): string[] {
  const total = bucketCount(result)
  const position = total === undefined ? `bucket ${onset.bucketIndex + 1}` : `bucket ${onset.bucketIndex + 1}/${total}`
  const sigmas = onset.sigmas !== null && Number.isFinite(onset.sigmas) ? `, ${onset.sigmas.toFixed(1)}σ` : ''
  const lines = [
    `Onset: ${onset.time} (${position}, rate ${percent(onset.errorRate)} vs baseline mean ` +
      `${percent(onset.baselineMean)} ±${percent(onset.baselineStdev)}, threshold ${percent(onset.threshold)}` +
      `${sigmas}, sustained ${onset.sustainedBuckets} buckets)`,
  ]
  if (onset.precedingEvent) {
    lines.push(`  preceded by ${onsetEventText(onset.precedingEvent)}`)
  }
  for (const nearby of (onset.nearbyEvents ?? []).slice(0, MAX_NEARBY_EVENTS)) {
    lines.push(`  nearby: ${onsetEventText(nearby)}`)
  }
  return lines
}

function patternLines(patterns: PatternDiff[]): string[] {
  const shown = patterns.slice(0, MAX_PATTERNS)
  const rest = patterns.length - shown.length
  const lines = [
    `Patterns (window counts extrapolated from the sampled rows)${rest > 0 ? `, top ${shown.length}` : ''}:`,
  ]
  for (const diff of shown) {
    const counts = `~${num(diff.estimatedTargetCount)} vs ~${num(diff.estimatedBaselineCount)}`
    const change =
      diff.kind === 'new'
        ? `(${percent(diff.targetRatio)} of the target sample)`
        : diff.kind === 'gone'
          ? `(${percent(diff.baselineRatio)} of the baseline sample)`
          : `(${ratio(diff.lift)})`
    lines.push(`  ${diff.kind.toUpperCase().padEnd(8)} ${counts} ${change} ${template(diff.template)}`)
  }
  if (rest > 0) {
    lines.push(`  +${rest} more changed templates`)
  }
  return lines
}

function facetLines(attribution: FacetAttribution): string[] {
  if (attribution.values.length === 0) {
    return []
  }
  const scale = attribution.baselineCovered > 0 ? attribution.targetCovered / attribution.baselineCovered : null
  const lines = [
    scale === null
      ? `${attribution.facet} attribution (the baseline window covers no logs, so every value is new):`
      : `${attribution.facet} attribution (excess = beyond a uniform ${ratio(scale)} scale-up):`,
  ]
  const shown = attribution.values.slice(0, MAX_FACET_VALUES)
  for (const value of shown) {
    // baselineTruncated means the baseline's tail was cut off, so a 0 count is a
    // lower bound — calling that value new would be a claim the data cannot make.
    const flag = value.baselineTruncated ? ' rare in baseline' : value.isNew ? ' NEW' : ''
    lines.push(
      `  ${value.value} ${num(value.targetCount)} vs ${num(value.baselineCount)} ` +
        `(${signed(value.excess)} excess, share ${percent(value.targetShare)} vs ${percent(value.baselineShare)})` +
        flag
    )
  }
  const rest = attribution.values.length - shown.length
  if (rest > 0) {
    lines.push(`  +${rest} more values`)
  }
  return lines
}

function onsetEventText(entry: OnsetEvent): string {
  // leadTimeMs is onset - event: positive means the event landed first.
  const relative = entry.leadTimeMs >= 0 ? 'before onset' : 'after onset'
  return `${eventText(entry.event)} (${duration(entry.leadTimeMs)} ${relative})`
}

function eventText(event: EventMarker): string {
  const parts = [event.time, `[${event.kind}]`, event.source ? `${event.source} —` : undefined, event.title]
  return parts.filter(Boolean).join(' ')
}

/** Total buckets in the target window, for "bucket 4/60"; undefined when the interval is unparseable. */
function bucketCount(result: ComparisonResult): number | undefined {
  const match = result.interval.match(/^(\d+)([smhd])$/)
  const unitMs = match ? INTERVAL_UNIT_MS[match[2]] : undefined
  if (!match || unitMs === undefined) {
    return undefined
  }
  const intervalMs = Number(match[1]) * unitMs
  const span = result.target.toMs - result.target.fromMs
  if (!Number.isFinite(span) || intervalMs <= 0 || span <= 0) {
    return undefined
  }
  return Math.ceil(span / intervalMs)
}

function deltaText(delta: VolumeDelta): string {
  return `${num(delta.targetCount)} vs ${num(delta.baselineCount)} (${signed(delta.delta)}, ${ratio(delta.ratio)})`
}

/**
 * A multiplier. `null` on the wire means the baseline side was 0 — rendering it
 * as a number would print Infinity or NaN, so it is spelled out instead.
 */
function ratio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'new (baseline 0)'
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)}x`
}

function num(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '-'
}

function signed(value: number): string {
  if (!Number.isFinite(value)) {
    return '-'
  }
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('en-US')}`
}

/** A 0–1 rate as a percentage. */
function percent(rate: number): string {
  return Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : '-'
}

/** A rate delta in percentage points, always signed. */
function ratePoints(delta: number): string {
  if (!Number.isFinite(delta)) {
    return '-'
  }
  const pts = delta * 100
  return `${pts > 0 ? '+' : ''}${pts.toFixed(1)} pts`
}

function duration(ms: number): string {
  const abs = Math.abs(ms)
  if (!Number.isFinite(abs)) {
    return '?'
  }
  if (abs < 60_000) {
    return `${Math.round(abs / 1000)}s`
  }
  if (abs < 3_600_000) {
    return `${Math.round(abs / 60_000)}m`
  }
  if (abs < 86_400_000) {
    return `${Math.round(abs / 3_600_000)}h`
  }
  return `${Math.round(abs / 86_400_000)}d`
}

/** Minute precision is enough for a window boundary. */
function shortIso(ms: number): string {
  // 8.64e15 is the Date range limit; toISOString() throws past it.
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) {
    return '(unknown)'
  }
  return `${new Date(ms).toISOString().slice(0, 16)}Z`
}

function template(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_PATTERN_TEMPLATE_LENGTH
    ? `${collapsed.slice(0, MAX_PATTERN_TEMPLATE_LENGTH)}…`
    : collapsed
}
