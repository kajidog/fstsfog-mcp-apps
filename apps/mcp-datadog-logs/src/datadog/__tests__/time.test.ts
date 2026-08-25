import { describe, expect, it } from 'vitest'
import {
  effectiveBaselineMode,
  parseBaselineSpec,
  parseTimeInput,
  pickInterval,
  rangesOverlap,
  resolveBaselineRange,
  resolveRange,
} from '../time.js'

const NOW = Date.parse('2026-07-06T12:00:00Z')

describe('parseTimeInput', () => {
  it('parses "now"', () => {
    expect(parseTimeInput('now', NOW)).toBe(NOW)
  })

  it('parses time math', () => {
    expect(parseTimeInput('now-15m', NOW)).toBe(NOW - 15 * 60_000)
    expect(parseTimeInput('now-4h', NOW)).toBe(NOW - 4 * 3_600_000)
    expect(parseTimeInput('now-2d', NOW)).toBe(NOW - 2 * 86_400_000)
    expect(parseTimeInput('now-1w', NOW)).toBe(NOW - 7 * 86_400_000)
  })

  it('parses ISO 8601', () => {
    expect(parseTimeInput('2026-07-06T10:00:00Z', NOW)).toBe(Date.parse('2026-07-06T10:00:00Z'))
    expect(parseTimeInput('2026-07-06T19:00:00+09:00', NOW)).toBe(Date.parse('2026-07-06T10:00:00Z'))
  })

  it('rejects absolute timestamps without an explicit time zone', () => {
    expect(() => parseTimeInput('2026-07-06T10:00:00', NOW)).toThrow(/must include a time zone/)
    expect(() => parseTimeInput('2026-07-06', NOW)).toThrow(/must include a time zone/)
  })

  it('parses epoch seconds and millis', () => {
    expect(parseTimeInput('1751800000', NOW)).toBe(1_751_800_000_000)
    expect(parseTimeInput('1751800000000', NOW)).toBe(1_751_800_000_000)
  })

  it('rejects garbage', () => {
    expect(() => parseTimeInput('yesterday-ish', NOW)).toThrow(/Unrecognized time value/)
  })
})

describe('resolveRange', () => {
  it('resolves from/to', () => {
    const range = resolveRange('now-1h', 'now', NOW)
    expect(range).toEqual({ fromMs: NOW - 3_600_000, toMs: NOW })
  })

  it('rejects inverted ranges', () => {
    expect(() => resolveRange('now', 'now-1h', NOW)).toThrow(/Invalid time range/)
  })
})

const DAY_MS = 86_400_000
const WEEK_MS = 604_800_000

describe('parseBaselineSpec', () => {
  it('defaults to the preceding window', () => {
    expect(parseBaselineSpec(undefined)).toEqual({ mode: 'previous' })
    expect(parseBaselineSpec('')).toEqual({ mode: 'previous' })
    expect(parseBaselineSpec('   ')).toEqual({ mode: 'previous' })
  })

  it('accepts every "previous" alias', () => {
    for (const alias of ['prev', 'previous', 'preceding', 'before', 'last']) {
      expect(parseBaselineSpec(alias)).toEqual({ mode: 'previous' })
    }
  })

  it('accepts every day alias', () => {
    for (const alias of ['yesterday', 'day', '1d', '24h', 'dod']) {
      expect(parseBaselineSpec(alias)).toEqual({ mode: 'shift', shiftMs: DAY_MS, label: '1d' })
    }
  })

  it('accepts every week alias', () => {
    for (const alias of ['last week', 'lastweek', 'week', '1w', '7d', 'wow']) {
      expect(parseBaselineSpec(alias)).toEqual({ mode: 'shift', shiftMs: WEEK_MS, label: '1w' })
    }
  })

  it('tolerates case and whitespace', () => {
    expect(parseBaselineSpec('  Previous ')).toEqual({ mode: 'previous' })
    expect(parseBaselineSpec(' Last  Week ')).toEqual({ mode: 'shift', shiftMs: WEEK_MS, label: '1w' })
    expect(parseBaselineSpec('DoD')).toEqual({ mode: 'shift', shiftMs: DAY_MS, label: '1d' })
    expect(parseBaselineSpec('3 d')).toEqual({ mode: 'shift', shiftMs: 3 * DAY_MS, label: '3d' })
  })

  it('does not glue separated digits into a larger shift', () => {
    // "1 2 d" must not silently become a 12-day shift.
    expect(() => parseBaselineSpec('1 2 d')).toThrow(/Unrecognized baseline/)
    // The alias table is whitespace-insensitive, so without a guard ahead of it
    // "2 4 h" would compact to "24h" and come back as a one-day shift.
    expect(() => parseBaselineSpec('2 4 h')).toThrow(/Unrecognized baseline/)
    expect(() => parseBaselineSpec('now-1 2 d')).toThrow(/Unrecognized baseline/)
    expect(() => parseBaselineSpec('2 3 h')).toThrow(/Unrecognized baseline/)
  })

  it("accepts this server's own time-math spelling", () => {
    expect(parseBaselineSpec('now-1d')).toEqual({ mode: 'shift', shiftMs: DAY_MS, label: '1d' })
    expect(parseBaselineSpec('now-4h')).toEqual({ mode: 'shift', shiftMs: 4 * 3_600_000, label: '4h' })
    expect(parseBaselineSpec('NOW - 2 w')).toEqual({ mode: 'shift', shiftMs: 2 * WEEK_MS, label: '2w' })
  })

  it('accepts a leading plus as the same backwards shift', () => {
    expect(parseBaselineSpec('+3d')).toEqual({ mode: 'shift', shiftMs: 3 * DAY_MS, label: '3d' })
  })

  it('parses generic shifts', () => {
    expect(parseBaselineSpec('4h')).toEqual({ mode: 'shift', shiftMs: 4 * 3_600_000, label: '4h' })
    expect(parseBaselineSpec('2h')).toEqual({ mode: 'shift', shiftMs: 2 * 3_600_000, label: '2h' })
    expect(parseBaselineSpec('30m')).toEqual({ mode: 'shift', shiftMs: 30 * 60_000, label: '30m' })
    expect(parseBaselineSpec('2w')).toEqual({ mode: 'shift', shiftMs: 2 * WEEK_MS, label: '2w' })
  })

  it('treats a leading minus as the same backwards shift', () => {
    expect(parseBaselineSpec('-3d')).toEqual({ mode: 'shift', shiftMs: 3 * DAY_MS, label: '3d' })
    expect(parseBaselineSpec('-4h')).toEqual({ mode: 'shift', shiftMs: 4 * 3_600_000, label: '4h' })
  })

  it('omits shift fields entirely for mode "previous"', () => {
    const spec = parseBaselineSpec('previous')
    expect('shiftMs' in spec).toBe(false)
    expect('label' in spec).toBe(false)
  })

  it('reports the same label whether or not the shift carries a now- prefix', () => {
    // The label is echoed onto ComparisonParams.shift, so two spellings of the
    // same offset must not read differently in the result.
    expect(parseBaselineSpec('now-24h')).toEqual(parseBaselineSpec('24h'))
    expect(parseBaselineSpec('now-1d')).toEqual(parseBaselineSpec('1d'))
    expect(parseBaselineSpec('now-7d')).toEqual(parseBaselineSpec('1w'))
    expect(parseBaselineSpec('now-24h').label).toBe('1d')
  })

  it('rejects zero-magnitude shifts', () => {
    for (const value of ['0d', '0h', '-0d', '0w', '0m']) {
      expect(() => parseBaselineSpec(value)).toThrow(/Unrecognized baseline/)
    }
  })

  it('rejects unknown values with the exact message', () => {
    expect(() => parseBaselineSpec('sometime')).toThrow(
      'Unrecognized baseline: "sometime". Use "previous", "1d", "1w", a shift like "4h"/"3d", or baselineFrom/baselineTo.'
    )
    // The original spelling is echoed back, not the normalized one.
    expect(() => parseBaselineSpec(' Two Weeks ')).toThrow(
      'Unrecognized baseline: " Two Weeks ". Use "previous", "1d", "1w", a shift like "4h"/"3d", or baselineFrom/baselineTo.'
    )
    expect(() => parseBaselineSpec('5y')).toThrow(/Unrecognized baseline/)
    expect(() => parseBaselineSpec('1.5d')).toThrow(/Unrecognized baseline/)
  })
})

describe('resolveBaselineRange', () => {
  const target = resolveRange('now-1h', 'now', NOW)
  const targetDuration = target.toMs - target.fromMs

  it('places the previous window immediately before the target', () => {
    const baseline = resolveBaselineRange(target, { mode: 'previous' }, undefined, NOW)
    expect(baseline).toEqual({ fromMs: NOW - 2 * 3_600_000, toMs: NOW - 3_600_000 })
    expect(baseline.toMs - baseline.fromMs).toBe(targetDuration)
  })

  it('slides the whole window back for mode "shift"', () => {
    const baseline = resolveBaselineRange(target, parseBaselineSpec('1d'), undefined, NOW)
    expect(baseline).toEqual({ fromMs: target.fromMs - DAY_MS, toMs: target.toMs - DAY_MS })
    expect(baseline.toMs - baseline.fromMs).toBe(targetDuration)
  })

  it('keeps the baseline the same length as the target in every mode', () => {
    const wide = resolveRange('now-3d', 'now', NOW)
    const wideDuration = wide.toMs - wide.fromMs
    const cases = [
      resolveBaselineRange(wide, { mode: 'previous' }, undefined, NOW),
      resolveBaselineRange(wide, parseBaselineSpec('1w'), undefined, NOW),
      resolveBaselineRange(wide, { mode: 'custom' }, { from: '2026-06-01T00:00:00Z' }, NOW),
    ]
    for (const baseline of cases) {
      expect(baseline.toMs - baseline.fromMs).toBe(wideDuration)
    }
  })

  it('derives the custom end from the target duration when baselineTo is omitted', () => {
    const from = '2026-07-01T00:00:00Z'
    const baseline = resolveBaselineRange(target, { mode: 'custom' }, { from }, NOW)
    expect(baseline.fromMs).toBe(Date.parse(from))
    expect(baseline.toMs).toBe(Date.parse(from) + targetDuration)
  })

  it('honours an explicit custom end', () => {
    const baseline = resolveBaselineRange(
      target,
      { mode: 'custom' },
      { from: '2026-07-01T00:00:00Z', to: '2026-07-01T06:00:00Z' },
      NOW
    )
    expect(baseline).toEqual({
      fromMs: Date.parse('2026-07-01T00:00:00Z'),
      toMs: Date.parse('2026-07-01T06:00:00Z'),
    })
  })

  it('anchors the window on baselineTo alone, inheriting the target duration', () => {
    const to = '2026-07-01T06:00:00Z'
    const baseline = resolveBaselineRange(target, { mode: 'custom' }, { to }, NOW)
    expect(baseline.toMs).toBe(Date.parse(to))
    expect(baseline.fromMs).toBe(Date.parse(to) - targetDuration)
  })

  it('resolves from-only, to-only and both to the same window when they agree', () => {
    const from = '2026-07-01T05:00:00Z'
    const to = '2026-07-01T06:00:00Z'
    const expected = { fromMs: Date.parse(from), toMs: Date.parse(to) }
    expect(resolveBaselineRange(target, { mode: 'custom' }, { from }, NOW)).toEqual(expected)
    expect(resolveBaselineRange(target, { mode: 'custom' }, { to }, NOW)).toEqual(expected)
    expect(resolveBaselineRange(target, { mode: 'custom' }, { from, to }, NOW)).toEqual(expected)
  })

  it('rejects mode "custom" with no usable bound instead of silently using the previous window', () => {
    expect(() => resolveBaselineRange(target, { mode: 'custom' }, undefined, NOW)).toThrow(/Invalid baseline/)
    expect(() => resolveBaselineRange(target, { mode: 'custom' }, {}, NOW)).toThrow(/Invalid baseline/)
    // Blank strings are not usable bounds either.
    expect(() => resolveBaselineRange(target, { mode: 'custom' }, { from: '   ' }, NOW)).toThrow(
      'Invalid baseline: mode "custom" requires baselineFrom or baselineTo.'
    )
    expect(() => resolveBaselineRange(target, { mode: 'custom' }, { from: '', to: '  ' }, NOW)).toThrow(
      /Invalid baseline/
    )
  })

  it('treats a blank bound as absent, exactly as effectiveBaselineMode does', () => {
    const blank = { from: '   ' }
    expect(effectiveBaselineMode({ mode: 'previous' }, blank)).toBe('previous')
    // The resolver agrees: a blank bound does not make this a custom window.
    expect(resolveBaselineRange(target, { mode: 'previous' }, blank, NOW)).toEqual(
      resolveBaselineRange(target, { mode: 'previous' }, undefined, NOW)
    )
  })

  it('never interpolates undefined or an empty string into the inversion message', () => {
    const degenerate = { fromMs: NOW, toMs: NOW }
    // duration 0, so the derived end equals the supplied start.
    expect(() => resolveBaselineRange(degenerate, { mode: 'custom' }, { from: 'now-1h' }, NOW)).toThrow(
      /baselineTo \(2026-07-06T11:00:00\.000Z\)/
    )
    expect(() => resolveBaselineRange(degenerate, { mode: 'custom' }, { to: 'now-1h' }, NOW)).toThrow(
      /baselineFrom \(2026-07-06T11:00:00\.000Z\)/
    )
    for (const explicit of [{ from: 'now-1h' }, { to: 'now-1h' }]) {
      expect(() => resolveBaselineRange(degenerate, { mode: 'custom' }, explicit, NOW)).toThrow(
        /^(?!.*(?:undefined|\(\))).*Invalid baseline range/s
      )
    }
  })

  it('lets explicit bounds win over the parsed spec', () => {
    const baseline = resolveBaselineRange(target, parseBaselineSpec('1w'), { from: 'now-2h' }, NOW)
    expect(baseline.fromMs).toBe(NOW - 2 * 3_600_000)
  })

  it('rejects custom bounds without an explicit time zone', () => {
    expect(() => resolveBaselineRange(target, { mode: 'custom' }, { from: '2026-07-01T00:00:00' }, NOW)).toThrow(
      /must include a time zone/
    )
    expect(() =>
      resolveBaselineRange(target, { mode: 'custom' }, { from: 'now-2h', to: '2026-07-01T00:00:00' }, NOW)
    ).toThrow(/must include a time zone/)
  })

  it('rejects inverted custom bounds', () => {
    expect(() => resolveBaselineRange(target, { mode: 'custom' }, { from: 'now', to: 'now-1h' }, NOW)).toThrow(
      /Invalid baseline range/
    )
    expect(() => resolveBaselineRange(target, { mode: 'custom' }, { from: 'now-1h', to: 'now-1h' }, NOW)).toThrow(
      /Invalid baseline range/
    )
  })

  it('rejects a shift spec without a usable offset', () => {
    expect(() => resolveBaselineRange(target, { mode: 'shift' }, undefined, NOW)).toThrow(/requires a positive shiftMs/)
  })

  it('is deterministic under a frozen clock', () => {
    const frozen = resolveRange('now-1h', 'now', NOW)
    const first = resolveBaselineRange(frozen, parseBaselineSpec('4h'), { from: 'now-9h' }, NOW)
    const second = resolveBaselineRange(frozen, parseBaselineSpec('4h'), { from: 'now-9h' }, NOW)
    expect(first).toEqual(second)
    expect(first).toEqual({ fromMs: NOW - 9 * 3_600_000, toMs: NOW - 8 * 3_600_000 })
  })
})

describe('effectiveBaselineMode', () => {
  it('reports "custom" when either bound is supplied', () => {
    expect(effectiveBaselineMode({ mode: 'previous' }, { from: 'now-2h' })).toBe('custom')
    expect(effectiveBaselineMode({ mode: 'previous' }, { to: 'now-2h' })).toBe('custom')
    expect(effectiveBaselineMode(parseBaselineSpec('1w'), { from: 'now-2h', to: 'now-1h' })).toBe('custom')
  })

  it('falls back to the parsed spec mode without bounds', () => {
    expect(effectiveBaselineMode({ mode: 'previous' })).toBe('previous')
    expect(effectiveBaselineMode(parseBaselineSpec('1d'), {})).toBe('shift')
  })

  it('agrees with resolveBaselineRange on blank-string bounds', () => {
    const target = resolveRange('now-1h', 'now', NOW)
    for (const explicit of [{ from: '   ' }, { to: '' }, { from: '', to: '  ' }]) {
      expect(effectiveBaselineMode({ mode: 'previous' }, explicit)).toBe('previous')
      // A mode the helper does not call custom must not be resolvable as custom either.
      expect(() => resolveBaselineRange(target, { mode: 'custom' }, explicit, NOW)).toThrow(/Invalid baseline/)
      expect(resolveBaselineRange(target, { mode: 'previous' }, explicit, NOW)).toEqual(
        resolveBaselineRange(target, { mode: 'previous' }, undefined, NOW)
      )
    }
  })
})

describe('rangesOverlap', () => {
  it('detects overlapping windows', () => {
    expect(rangesOverlap({ fromMs: 0, toMs: 100 }, { fromMs: 50, toMs: 150 })).toBe(true)
    expect(rangesOverlap({ fromMs: 50, toMs: 150 }, { fromMs: 0, toMs: 100 })).toBe(true)
  })

  it('treats touching and disjoint windows as non-overlapping', () => {
    expect(rangesOverlap({ fromMs: 0, toMs: 100 }, { fromMs: 100, toMs: 200 })).toBe(false)
    expect(rangesOverlap({ fromMs: 0, toMs: 100 }, { fromMs: 500, toMs: 600 })).toBe(false)
  })

  it('reports no overlap for a "previous" baseline', () => {
    const target = resolveRange('now-1h', 'now', NOW)
    expect(rangesOverlap(target, resolveBaselineRange(target, { mode: 'previous' }, undefined, NOW))).toBe(false)
  })
})

describe('pickInterval', () => {
  it('targets ~60 buckets', () => {
    expect(pickInterval(15 * 60_000).label).toBe('30s')
    expect(pickInterval(3_600_000).label).toBe('1m')
    expect(pickInterval(4 * 3_600_000).label).toBe('5m')
    expect(pickInterval(24 * 3_600_000).label).toBe('30m')
    expect(pickInterval(7 * 86_400_000).label).toBe('4h')
  })

  it('caps at 1d for huge ranges', () => {
    expect(pickInterval(365 * 86_400_000).label).toBe('1d')
  })
})
