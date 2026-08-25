import type { EventMarker, FacetBreakdown, LogRow, LogStatus, TimelineBucket } from '@kajidog/investigation-shared'
import { describe, expect, it } from 'vitest'
import {
  attributeFacets,
  compareVolume,
  correlateOnsetEvents,
  detectOnset,
  diffPatterns,
  summarizeWindow,
} from '../comparison.js'

const BASE_MS = Date.parse('2026-07-06T10:00:00.000Z')
const MINUTE = 60_000

/** Builds a facet breakdown from a plain {value: count} map. */
function facet(name: string, values: Record<string, number>, otherCount?: number): FacetBreakdown {
  return {
    facet: name,
    values: Object.entries(values).map(([value, count]) => ({ value, count })),
    ...(otherCount === undefined ? {} : { otherCount }),
  }
}

let rowSeq = 0

function row(message: string, status: LogStatus = 'error'): LogRow {
  rowSeq += 1
  return { id: `row-${rowSeq}`, timestamp: '2026-07-06T10:00:00.000Z', status, message }
}

/** `count` rows sharing one message (and therefore one template). */
function repeat(message: string, count: number): LogRow[] {
  return Array.from({ length: count }, () => row(message))
}

/** Distinct digit-free word for generating many distinct templates ('aa', 'ab', ...). */
function alphaWord(index: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  return `${letters[Math.floor(index / 26) % 26]}${letters[index % 26]}`
}

/** Bucket counts as one shared type, so ternaries between shapes stay assignable. */
function mix(errorCount: number, total: number): Record<string, number> {
  return { error: errorCount, info: total - errorCount }
}

function bucket(index: number, counts: Record<string, number>): TimelineBucket {
  return { time: new Date(BASE_MS + index * MINUTE).toISOString(), counts }
}

function buckets(length: number, countsAt: (index: number) => Record<string, number>): TimelineBucket[] {
  return Array.from({ length }, (_, index) => bucket(index, countsAt(index)))
}

/** Flat, error-free baseline: mean = stdev = 0, so only the absolute floor applies. */
const FLAT_ZERO_BASELINE = buckets(4, () => mix(0, 100))

function event(id: string, offsetMs: number): EventMarker {
  return { id, time: new Date(BASE_MS + offsetMs).toISOString(), kind: 'deploy', title: id }
}

describe('summarizeWindow', () => {
  it('counts otherCount in the total and the errorRate denominator but not in statusCounts', () => {
    const window = summarizeWindow(facet('status', { error: 5, info: 5 }, 10), BASE_MS, BASE_MS + MINUTE)
    expect(window.totalCount).toBe(20)
    expect(window.statusCounts).toEqual({ error: 5, info: 5 })
    // 5 / 20, not 5 / 10 — the unknown-status logs are part of the denominator.
    expect(window.errorRate).toBeCloseTo(0.25, 10)
    expect(window.fromMs).toBe(BASE_MS)
    expect(window.toMs).toBe(BASE_MS + MINUTE)
  })

  it('omits lowSample at the MIN_WINDOW_SAMPLE floor and sets it below', () => {
    const atFloor = summarizeWindow(facet('status', { info: 20 }), BASE_MS, BASE_MS + MINUTE)
    expect('lowSample' in atFloor).toBe(false)

    const belowFloor = summarizeWindow(facet('status', { info: 19 }), BASE_MS, BASE_MS + MINUTE)
    expect('lowSample' in belowFloor).toBe(true)
    expect(belowFloor.lowSample).toBe(true)
  })

  it('reports errorRate 0 for an empty window instead of dividing by zero', () => {
    const window = summarizeWindow(facet('status', {}), BASE_MS, BASE_MS + MINUTE)
    expect(window.totalCount).toBe(0)
    expect(window.errorRate).toBe(0)
    expect(Number.isNaN(window.errorRate)).toBe(false)
    expect('lowSample' in window).toBe(true)
  })
})

describe('compareVolume', () => {
  it('reports ratio null (never Infinity) for every zero-baseline denominator', () => {
    const target = summarizeWindow(facet('status', { error: 5, info: 15 }), BASE_MS, BASE_MS + MINUTE)
    const baseline = summarizeWindow(facet('status', {}), BASE_MS - MINUTE, BASE_MS)
    const comparison = compareVolume(target, baseline)

    expect(comparison.total.ratio).toBeNull()
    expect(comparison.total.delta).toBe(20)
    for (const status of comparison.byStatus) {
      expect(status.ratio).toBeNull()
    }
  })

  it('covers the union of both windows statuses, counting the missing side as 0', () => {
    const target = summarizeWindow(facet('status', { error: 10, info: 2 }), BASE_MS, BASE_MS + MINUTE)
    const baseline = summarizeWindow(facet('status', { error: 4, warn: 6 }), BASE_MS - MINUTE, BASE_MS)
    const comparison = compareVolume(target, baseline)

    expect(comparison.byStatus.map((entry) => entry.status).sort()).toEqual(['error', 'info', 'warn'])
    const info = comparison.byStatus.find((entry) => entry.status === 'info')
    expect(info).toMatchObject({ targetCount: 2, baselineCount: 0, delta: 2, ratio: null })
    const warn = comparison.byStatus.find((entry) => entry.status === 'warn')
    expect(warn).toMatchObject({ targetCount: 0, baselineCount: 6, delta: -6, ratio: 0 })
    // Loudest target status first.
    expect(comparison.byStatus[0].status).toBe('error')
  })
})

describe('uniform scale-up (signature property)', () => {
  it('produces ratio 3, no errorRate change, and ~zero excess for every facet value', () => {
    const baselineStatus = facet('status', { error: 20, info: 180 })
    const targetStatus = facet('status', { error: 60, info: 540 })
    const baselineWindow = summarizeWindow(baselineStatus, BASE_MS - 10 * MINUTE, BASE_MS)
    const targetWindow = summarizeWindow(targetStatus, BASE_MS, BASE_MS + 10 * MINUTE)
    const comparison = compareVolume(targetWindow, baselineWindow)

    expect(comparison.total.ratio).toBe(3)
    expect(comparison.errorRateDelta).toBeCloseTo(0, 10)
    for (const status of comparison.byStatus) {
      expect(status.ratio).toBe(3)
    }

    // Every service tripled too: nothing grew disproportionately, so nothing
    // may rank as a cause.
    const baselineServices = facet('service', { checkout: 100, search: 60, billing: 40 })
    const targetServices = facet('service', { checkout: 300, search: 180, billing: 120 })
    const attribution = attributeFacets('service', targetServices, baselineServices, 600, 200)

    expect(attribution.values).toHaveLength(3)
    for (const value of attribution.values) {
      expect(value.excess).toBeCloseTo(0, 10)
      expect(value.lift).toBeCloseTo(1, 10)
    }
  })
})

describe('diffPatterns', () => {
  it('compares ratios, not counts: a 5x larger sample with the same mix spikes nothing', () => {
    const targetRows = [
      ...repeat('alpha request failed', 100),
      ...repeat('beta cache miss', 60),
      ...repeat('gamma upstream timeout', 40),
    ]
    const baselineRows = [
      ...repeat('alpha request failed', 20),
      ...repeat('beta cache miss', 12),
      ...repeat('gamma upstream timeout', 8),
    ]
    const result = diffPatterns(targetRows, baselineRows, 20_000, 4_000)

    expect(result.targetAnalyzed).toBe(200)
    expect(result.baselineAnalyzed).toBe(40)
    expect(result.diffs.filter((diff) => diff.kind === 'spiking')).toEqual([])
    expect(result.diffs).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('ignores a template with 2 sample occurrences and reports it at 3', () => {
    const belowFloor = diffPatterns(
      [...repeat('alpha exploded', 2), ...repeat('beta heartbeat', 8)],
      repeat('beta heartbeat', 10),
      1000,
      1000
    )
    expect(belowFloor.diffs.map((diff) => diff.template)).toEqual([])

    const atFloor = diffPatterns(
      [...repeat('alpha exploded', 3), ...repeat('beta heartbeat', 7)],
      repeat('beta heartbeat', 10),
      1000,
      1000
    )
    expect(atFloor.diffs).toHaveLength(1)
    expect(atFloor.diffs[0]).toMatchObject({ template: 'alpha exploded', kind: 'new', targetSampleCount: 3 })
  })

  it('classifies new / spiking / dropping / gone and leaves a stable template out', () => {
    const targetRows = [
      ...repeat('newthing exploded', 10),
      ...repeat('spiky degraded', 30),
      ...repeat('droppy recovered', 5),
      ...repeat('stable heartbeat', 55),
    ]
    const baselineRows = [
      ...repeat('spiky degraded', 10),
      ...repeat('droppy recovered', 30),
      ...repeat('gonzo vanished', 20),
      ...repeat('stable heartbeat', 40),
    ]
    const result = diffPatterns(targetRows, baselineRows, 1000, 1000)

    // Report order: new, spiking, dropping, gone.
    expect(result.diffs.map((diff) => diff.kind)).toEqual(['new', 'spiking', 'dropping', 'gone'])
    expect(result.diffs.map((diff) => diff.template)).toEqual([
      'newthing exploded',
      'spiky degraded',
      'droppy recovered',
      'gonzo vanished',
    ])
    expect(result.diffs.every((diff) => diff.template !== 'stable heartbeat')).toBe(true)

    const [added, spiking, dropping, gone] = result.diffs
    expect(added.lift).toBeNull()
    expect(added.baselineSampleCount).toBe(0)
    expect(spiking.lift).toBeCloseTo(3, 10)
    expect(Number.isFinite(spiking.lift ?? Number.NaN)).toBe(true)
    expect(dropping.lift).toBeCloseTo(1 / 6, 10)
    expect(gone.targetSampleCount).toBe(0)
    expect(gone.targetRatio).toBe(0)
  })

  it('extrapolates estimated counts onto the window totals, not the sample sizes', () => {
    const result = diffPatterns(
      [...repeat('alpha exploded', 4), ...repeat('beta heartbeat', 6)],
      [...repeat('alpha exploded', 1), ...repeat('beta heartbeat', 49)],
      5000,
      1000
    )
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0]).toMatchObject({
      template: 'alpha exploded',
      kind: 'spiking',
      targetSampleCount: 4,
      baselineSampleCount: 1,
      // 0.4 of the sample projected onto 5000 window logs, not the 10 sampled rows.
      estimatedTargetCount: 2000,
      estimatedBaselineCount: 20,
    })
    expect(result.diffs[0].targetRatio).toBeCloseTo(0.4, 10)
  })

  it('does not count blank or whitespace-only messages as analyzed rows', () => {
    const result = diffPatterns(
      [...repeat('alpha exploded', 5), row(''), row('   ')],
      [...repeat('beta heartbeat', 4), row('')],
      1000,
      1000
    )
    expect(result.targetAnalyzed).toBe(5)
    expect(result.baselineAnalyzed).toBe(4)
    // Ratios are taken against the analyzed count, so alpha is the whole sample.
    expect(result.diffs[0].targetRatio).toBeCloseTo(1, 10)
  })

  it('caps the diff list at MAX_PATTERN_DIFFS', () => {
    const targetRows = Array.from({ length: 20 }, (_, index) => repeat(`${alphaWord(index)} exploded`, 3)).flat()
    const result = diffPatterns(targetRows, repeat('base heartbeat', 10), 1000, 1000)

    expect(result.diffs).toHaveLength(15)
    expect(result.diffs.every((diff) => diff.kind === 'new')).toBe(true)
  })

  it('flags truncated when a window hits PATTERN_CLUSTER_LIMIT distinct templates', () => {
    const wideRows = Array.from({ length: 100 }, (_, index) => row(`${alphaWord(index)} exploded`))
    expect(diffPatterns(wideRows, repeat('base heartbeat', 10), 1000, 1000).truncated).toBe(true)
    expect(diffPatterns(repeat('base heartbeat', 10), wideRows, 1000, 1000).truncated).toBe(true)

    const narrowRows = Array.from({ length: 99 }, (_, index) => row(`${alphaWord(index)} exploded`))
    expect(diffPatterns(narrowRows, repeat('base heartbeat', 10), 1000, 1000).truncated).toBe(false)
  })
})

describe('attributeFacets', () => {
  it('flags a value missing from a truncated baseline as baselineTruncated, never isNew', () => {
    const attribution = attributeFacets(
      'service',
      facet('service', { 'svc-a': 100, 'svc-new': 50 }),
      facet('service', { 'svc-a': 100 }),
      150,
      200 // baselineCovered (100) < baselineTotal (200): the tail was cut off.
    )
    const fresh = attribution.values.find((value) => value.value === 'svc-new')
    expect(fresh).toBeDefined()
    expect('baselineTruncated' in (fresh ?? {})).toBe(true)
    expect(fresh?.baselineTruncated).toBe(true)
    expect('isNew' in (fresh ?? {})).toBe(false)
    expect(fresh?.lift).toBeNull()
  })

  it('flags a value missing from a complete baseline as isNew', () => {
    const attribution = attributeFacets(
      'service',
      facet('service', { 'svc-a': 100, 'svc-new': 50 }),
      facet('service', { 'svc-a': 100 }),
      150,
      100 // baselineCovered === baselineTotal: the baseline really lacks svc-new.
    )
    const fresh = attribution.values.find((value) => value.value === 'svc-new')
    expect('isNew' in (fresh ?? {})).toBe(true)
    expect(fresh?.isNew).toBe(true)
    expect('baselineTruncated' in (fresh ?? {})).toBe(false)
  })

  it('treats every target occurrence as excess when the baseline covered nothing', () => {
    const attribution = attributeFacets(
      'service',
      facet('service', { 'svc-a': 10, 'svc-b': 4 }),
      facet('service', {}),
      14,
      0
    )
    expect(attribution.baselineCovered).toBe(0)
    for (const value of attribution.values) {
      expect(value.excess).toBe(value.targetCount)
      expect(value.lift).toBeNull()
      expect(Number.isFinite(value.excess)).toBe(true)
    }
    expect(attribution.values.map((value) => value.value)).toEqual(['svc-a', 'svc-b'])
  })

  it('keeps the facet with an empty value list when the target covered nothing', () => {
    const attribution = attributeFacets('service', facet('service', {}), facet('service', { 'svc-a': 10 }), 0, 10)
    expect(attribution).toEqual({
      facet: 'service',
      values: [],
      targetCovered: 0,
      baselineCovered: 10,
      targetTotal: 0,
      baselineTotal: 10,
    })
  })

  it('ranks by |excess| descending with positives ahead of equal-magnitude negatives', () => {
    // Covered totals match, so scale = 1 and excess = targetCount - baselineCount.
    const attribution = attributeFacets(
      'service',
      facet('service', { 'up-big': 100, 'down-big': 10, 'tie-pos': 20, 'tie-neg': 5 }),
      facet('service', { 'up-big': 50, 'down-big': 60, 'tie-pos': 15, 'tie-neg': 10 }),
      135,
      135
    )
    expect(attribution.values.map((value) => value.value)).toEqual(['up-big', 'down-big', 'tie-pos', 'tie-neg'])
    expect(attribution.values.map((value) => value.excess)).toEqual([50, -50, 5, -5])
  })

  it('caps the ranked values at MAX_ATTRIBUTION_VALUES', () => {
    const targetCounts: Record<string, number> = {}
    const baselineCounts: Record<string, number> = {}
    for (let index = 0; index < 12; index += 1) {
      targetCounts[alphaWord(index)] = 100 + index * 10
      baselineCounts[alphaWord(index)] = 100
    }
    const covered = Object.values(targetCounts).reduce((sum, count) => sum + count, 0)
    const attribution = attributeFacets(
      'service',
      facet('service', targetCounts),
      facet('service', baselineCounts),
      covered,
      1200
    )
    expect(attribution.values).toHaveLength(10)
    expect(attribution.targetCovered).toBe(covered)
    expect(attribution.baselineCovered).toBe(1200)
  })
})

describe('detectOnset', () => {
  it('uses the absolute floor on a sigma-zero baseline instead of blowing up', () => {
    // Baseline mean = stdev = 0, so threshold is the 2-point floor.
    const belowFloor = detectOnset(
      buckets(12, (index) => (index >= 3 && index <= 8 ? mix(2, 100) : mix(0, 100))),
      FLAT_ZERO_BASELINE
    )
    expect(belowFloor).toBeUndefined()

    const aboveFloor = detectOnset(
      buckets(12, (index) => (index >= 3 && index <= 5 ? mix(30, 100) : mix(0, 100))),
      FLAT_ZERO_BASELINE
    )
    expect(aboveFloor).toBeDefined()
    expect(aboveFloor?.baselineMean).toBe(0)
    expect(aboveFloor?.baselineStdev).toBe(0)
    expect(aboveFloor?.threshold).toBeCloseTo(0.02, 10)
    // No sigma is meaningful against a zero-variance baseline.
    expect(aboveFloor?.sigmas).toBeNull()
    expect(aboveFloor?.bucketIndex).toBe(3)
    expect(aboveFloor?.errorRate).toBeCloseTo(0.3, 10)
    expect(aboveFloor?.sustainedBuckets).toBe(3)
    expect(aboveFloor?.time).toBe(new Date(BASE_MS + 3 * MINUTE).toISOString())
  })

  it('uses the sigma test when the baseline actually varies', () => {
    // Rates 0.10 and 0.20: mean 0.15, stdev ~0.0707, threshold ~0.362.
    const noisyBaseline = [bucket(0, mix(10, 100)), bucket(1, mix(20, 100))]

    const withinSigma = detectOnset(
      buckets(12, (index) => (index >= 3 ? mix(25, 100) : mix(0, 100))),
      noisyBaseline
    )
    // 0.25 clears mean + floor but not mean + 3 sigma.
    expect(withinSigma).toBeUndefined()

    const beyondSigma = detectOnset(
      buckets(12, (index) => (index >= 3 && index <= 5 ? mix(50, 100) : mix(0, 100))),
      noisyBaseline
    )
    expect(beyondSigma?.baselineMean).toBeCloseTo(0.15, 10)
    expect(beyondSigma?.baselineStdev).toBeCloseTo(Math.sqrt(0.005), 10)
    expect(beyondSigma?.threshold).toBeCloseTo(0.15 + 3 * Math.sqrt(0.005), 10)
    expect(beyondSigma?.sigmas).toBeCloseTo((0.5 - 0.15) / Math.sqrt(0.005), 6)
  })

  it('does not fire on a single spiking bucket', () => {
    const onset = detectOnset(
      buckets(12, (index) => (index === 5 ? mix(60, 100) : mix(0, 100))),
      FLAT_ZERO_BASELINE
    )
    expect(onset).toBeUndefined()
  })

  it('reports the actual run length when it exceeds the sustain minimum', () => {
    const onset = detectOnset(
      buckets(12, (index) => (index >= 2 && index <= 6 ? mix(40, 100) : mix(0, 100))),
      FLAT_ZERO_BASELINE
    )
    expect(onset?.bucketIndex).toBe(2)
    expect(onset?.sustainedBuckets).toBe(5)
  })

  it('never picks a thin bucket as the onset and lets one pass through a sustained run', () => {
    const thin = mix(5, 5) // total 5 < ONSET_MIN_BUCKET_TOTAL, 100% errors
    const hot = mix(40, 100)
    const onset = detectOnset(
      buckets(12, (index) => {
        if (index === 4 || index === 7) {
          return thin
        }
        return index >= 5 && index <= 8 ? hot : mix(0, 100)
      }),
      FLAT_ZERO_BASELINE
    )
    // Bucket 4 is 100% errors but too thin to be the onset.
    expect(onset?.bucketIndex).toBe(5)
    // Buckets 5, 6, 8 count; the thin bucket 7 neither counts nor breaks the run.
    expect(onset?.sustainedBuckets).toBe(3)
  })

  it('returns undefined for an empty target timeline', () => {
    expect(detectOnset([], FLAT_ZERO_BASELINE)).toBeUndefined()
  })

  it('returns undefined with fewer than 2 qualifying baseline buckets', () => {
    const target = buckets(12, (index) => (index >= 3 && index <= 5 ? mix(30, 100) : mix(0, 100)))
    // One fat bucket plus thin ones leaves a single usable sample — no variance to compute.
    expect(detectOnset(target, [bucket(0, mix(5, 100)), bucket(1, mix(1, 5))])).toBeUndefined()
    expect(detectOnset(target, [])).toBeUndefined()
  })

  it('returns undefined when no bucket qualifies, so the caller can omit the key', () => {
    const result = detectOnset(
      buckets(12, () => mix(0, 100)),
      FLAT_ZERO_BASELINE
    )
    expect(result).toBeUndefined()
    const detection = { ...(result ? { onset: result } : {}) }
    expect('onset' in detection).toBe(false)
  })
})

describe('correlateOnsetEvents', () => {
  it('gives a preceding event a positive leadTimeMs', () => {
    const result = correlateOnsetEvents(BASE_MS, [event('deploy-a', -5 * MINUTE)], MINUTE)
    expect(result.precedingEvent?.event.id).toBe('deploy-a')
    expect(result.precedingEvent?.leadTimeMs).toBe(5 * MINUTE)
  })

  it('puts an event landing exactly at the onset in nearbyEvents, not precedingEvent', () => {
    const result = correlateOnsetEvents(BASE_MS, [event('deploy-at-onset', 0)], MINUTE)
    expect('precedingEvent' in result).toBe(false)
    expect(result.nearbyEvents).toHaveLength(1)
    expect(result.nearbyEvents?.[0]).toMatchObject({ leadTimeMs: 0 })
    expect(result.nearbyEvents?.[0].event.id).toBe('deploy-at-onset')
  })

  it('skips events with an unparseable time instead of producing NaN', () => {
    const broken: EventMarker = { id: 'broken', time: 'not-a-date', kind: 'other', title: 'broken' }
    const result = correlateOnsetEvents(BASE_MS, [broken, event('deploy-a', -2 * MINUTE)], MINUTE)
    expect(result.precedingEvent?.event.id).toBe('deploy-a')
    expect(Number.isNaN(result.precedingEvent?.leadTimeMs ?? Number.NaN)).toBe(false)
    expect('nearbyEvents' in result).toBe(false)
  })

  it('caps nearbyEvents chronologically and excludes the one chosen as precedingEvent', () => {
    const result = correlateOnsetEvents(
      BASE_MS,
      [
        event('e-10', -10 * MINUTE),
        event('e-25', -25 * MINUTE),
        event('e-05', -5 * MINUTE),
        event('e-20', -20 * MINUTE),
        event('e-15', -15 * MINUTE),
      ],
      MINUTE
    )
    expect(result.precedingEvent?.event.id).toBe('e-05')
    expect(result.nearbyEvents?.map((entry) => entry.event.id)).toEqual(['e-25', 'e-20', 'e-15'])
    const leadTimes = result.nearbyEvents?.map((entry) => entry.leadTimeMs) ?? []
    expect(leadTimes).toEqual([25 * MINUTE, 20 * MINUTE, 15 * MINUTE])
  })

  it('omits both keys when nothing is in range', () => {
    const result = correlateOnsetEvents(
      BASE_MS,
      [event('long-ago', -120 * MINUTE), event('later', 30 * MINUTE)],
      MINUTE
    )
    expect('precedingEvent' in result).toBe(false)
    expect('nearbyEvents' in result).toBe(false)
    expect(result).toEqual({})
  })

  it('widens the lookback with the bucket interval and clamps it at two hours', () => {
    const ninetyMinutesBack = [event('deploy-a', -90 * MINUTE)]
    // 1-minute buckets: the 30-minute default window misses it.
    expect('precedingEvent' in correlateOnsetEvents(BASE_MS, ninetyMinutesBack, MINUTE)).toBe(false)
    // 1-hour buckets: 2 * interval = 2h of lookback, so it lands in range.
    expect(correlateOnsetEvents(BASE_MS, ninetyMinutesBack, 60 * MINUTE).precedingEvent?.event.id).toBe('deploy-a')

    // 3-hour buckets would ask for 6h; the clamp holds the lookback at 2h.
    const wide = correlateOnsetEvents(
      BASE_MS,
      [event('too-old', -150 * MINUTE), event('just-inside', -110 * MINUTE)],
      180 * MINUTE
    )
    expect(wide.precedingEvent?.event.id).toBe('just-inside')
    expect('nearbyEvents' in wide).toBe(false)
  })
})
