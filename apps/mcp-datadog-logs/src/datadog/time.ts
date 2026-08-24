import type { BaselineMode } from '@kajidog/investigation-shared'

const TIME_MATH_PATTERN = /^now(?:\s*-\s*(\d+)\s*(s|m|h|d|w))?$/i

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/**
 * Parses a Datadog-style time input into epoch milliseconds.
 * Accepts "now", "now-15m" (s/m/h/d/w), ISO 8601, and epoch seconds/millis.
 * Datadog's API accepts the original strings directly; this local parse is
 * used only for interval selection and report labels.
 */
export function parseTimeInput(input: string, nowMs: number = Date.now()): number {
  const trimmed = input.trim()
  const math = trimmed.match(TIME_MATH_PATTERN)
  if (math) {
    if (!math[1]) {
      return nowMs
    }
    const amount = Number.parseInt(math[1], 10)
    const unit = math[2].toLowerCase()
    return nowMs - amount * UNIT_MS[unit]
  }
  if (/^\d{13}$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10)
  }
  if (/^\d{10}$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1_000
  }
  if (looksLikeIsoDate(trimmed) && !hasExplicitTimeZone(trimmed)) {
    throw new Error(
      `Ambiguous time value: "${input}". Absolute timestamps must include a time zone (for example "Z" or "+09:00").`
    )
  }
  const parsed = Date.parse(trimmed)
  if (!Number.isNaN(parsed)) {
    return parsed
  }
  throw new Error(`Unrecognized time value: "${input}". Use Datadog time math ("now-4h") or ISO 8601.`)
}

function looksLikeIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:T|$)/i.test(value)
}

function hasExplicitTimeZone(value: string): boolean {
  return /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
}

export interface ResolvedRange {
  fromMs: number
  toMs: number
}

export function resolveRange(from: string, to: string, nowMs: number = Date.now()): ResolvedRange {
  const fromMs = parseTimeInput(from, nowMs)
  const toMs = parseTimeInput(to, nowMs)
  if (fromMs >= toMs) {
    throw new Error(`Invalid time range: from (${from}) must be before to (${to}).`)
  }
  return { fromMs, toMs }
}

export interface BaselineSpec {
  mode: BaselineMode
  /** Millisecond offset for mode 'shift' */
  shiftMs?: number
  /** Original token, echoed onto ComparisonParams.shift */
  label?: string
}

const PREVIOUS_ALIASES = new Set(['prev', 'previous', 'preceding', 'before', 'last'])
const DAY_ALIASES = new Set(['yesterday', 'day', '1d', '24h', 'dod'])
const WEEK_ALIASES = new Set(['lastweek', 'week', '1w', '7d', 'wow'])
const SHIFT_PATTERN = /^-?(\d+)(m|h|d|w)$/

/**
 * Parses a baseline selector supplied by an LLM caller into a {@link BaselineSpec}.
 *
 * Matching is deliberately forgiving: the value is trimmed, lowercased and stripped of
 * internal whitespace before aliases are considered, so "Last Week", "lastweek" and
 * "1w" all resolve to the same weekly shift. An empty or missing value means
 * "the window immediately preceding the target".
 *
 * Known limitation: day/week/generic shifts are fixed millisecond offsets, so a window
 * that crosses a daylight-saving-time boundary lands an hour off in wall-clock terms.
 * Correcting that would require IANA-aware date math, which is deliberately out of scope.
 *
 * @throws if the value matches no alias or shift pattern, or resolves to a zero shift.
 */
export function parseBaselineSpec(value: string | undefined): BaselineSpec {
  const compact = (value ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (compact === '') {
    return { mode: 'previous' }
  }
  if (PREVIOUS_ALIASES.has(compact)) {
    return { mode: 'previous' }
  }
  // Day/week aliases are checked before the generic pattern so that "1d"/"7d"
  // report the canonical "1d"/"1w" labels while producing the same offsets.
  if (DAY_ALIASES.has(compact)) {
    return { mode: 'shift', shiftMs: UNIT_MS.d, label: '1d' }
  }
  if (WEEK_ALIASES.has(compact)) {
    return { mode: 'shift', shiftMs: UNIT_MS.w, label: '1w' }
  }
  const shift = compact.match(SHIFT_PATTERN)
  if (shift) {
    const amount = Number.parseInt(shift[1], 10)
    const unit = shift[2]
    const shiftMs = amount * UNIT_MS[unit]
    if (shiftMs > 0) {
      return { mode: 'shift', shiftMs, label: `${amount}${unit}` }
    }
  }
  throw new Error(
    `Unrecognized baseline: "${value}". Use "previous", "1d", "1w", a shift like "4h"/"3d", or baselineFrom/baselineTo.`
  )
}

/**
 * Resolves the baseline window to compare a target window against.
 *
 * An explicit `from` wins over `spec` and is treated as mode 'custom'; when `to` is
 * omitted the baseline inherits the target's duration. Otherwise 'previous' takes the
 * window immediately before the target and 'shift' slides the whole target window back
 * by `spec.shiftMs`. In every mode the baseline has exactly the target's length, which
 * is what makes the two windows comparable.
 *
 * Overlap with the target window is only reachable through explicit bounds and is not
 * an error here — callers can detect it with {@link rangesOverlap} and surface a notice.
 */
export function resolveBaselineRange(
  target: ResolvedRange,
  spec: BaselineSpec,
  explicit?: { from?: string; to?: string },
  nowMs: number = Date.now()
): ResolvedRange {
  const duration = target.toMs - target.fromMs
  const explicitFrom = explicit?.from?.trim()
  if (explicitFrom) {
    const explicitTo = explicit?.to?.trim()
    const fromMs = parseTimeInput(explicitFrom, nowMs)
    const toMs = explicitTo ? parseTimeInput(explicitTo, nowMs) : fromMs + duration
    if (fromMs >= toMs) {
      throw new Error(`Invalid time range: baselineFrom (${explicitFrom}) must be before baselineTo (${explicitTo}).`)
    }
    return { fromMs, toMs }
  }
  if (spec.mode === 'shift') {
    const shiftMs = spec.shiftMs
    if (!shiftMs || shiftMs <= 0) {
      throw new Error('Invalid baseline: mode "shift" requires a positive shiftMs.')
    }
    return { fromMs: target.fromMs - shiftMs, toMs: target.toMs - shiftMs }
  }
  // 'previous', and 'custom' without usable explicit bounds, fall back to the
  // window immediately preceding the target.
  return { fromMs: target.fromMs - duration, toMs: target.fromMs }
}

/** True when two windows share at least one instant. */
export function rangesOverlap(a: ResolvedRange, b: ResolvedRange): boolean {
  return a.fromMs < b.toMs && b.fromMs < a.toMs
}

const INTERVAL_STEPS: Array<{ label: string; ms: number }> = [
  { label: '10s', ms: 10_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
  { label: '15m', ms: 900_000 },
  { label: '30m', ms: 1_800_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '4h', ms: 14_400_000 },
  { label: '1d', ms: 86_400_000 },
]

/**
 * Picks a timeline bucket interval targeting ~60 buckets across the range,
 * snapped to a human-friendly step.
 */
export function pickInterval(rangeMs: number): { label: string; ms: number } {
  const target = rangeMs / 60
  for (const step of INTERVAL_STEPS) {
    if (step.ms >= target) {
      return step
    }
  }
  return INTERVAL_STEPS[INTERVAL_STEPS.length - 1]
}
