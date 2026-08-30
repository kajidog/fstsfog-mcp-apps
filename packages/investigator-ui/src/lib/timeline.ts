import type { TimelineBucket } from '@kajidog/investigation-shared'

/** Half-open [startMs, endMs) window of one or more timeline buckets. */
export interface BucketRange {
  startMs: number
  endMs: number
}

/** Milliseconds for a Datadog-style interval string ("5m", "1h"); 0 when unparseable. */
export function intervalToMs(interval: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(interval.trim())
  if (!match) {
    return 0
  }
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd']
  return Number(match[1]) * unitMs
}

/** The [start, end) window covered by a single bucket. */
export function resolveBucketRange(
  timeline: TimelineBucket[],
  bucketTime: string,
  interval: string,
  rangeEndMs: number
): BucketRange | null {
  const startMs = Date.parse(bucketTime)
  if (Number.isNaN(startMs)) {
    return null
  }
  const intervalMs = intervalToMs(interval)
  if (intervalMs > 0) {
    return { startMs, endMs: startMs + intervalMs }
  }
  // Unknown interval format: fall back to the next bucket's start (or the range end).
  const index = timeline.findIndex((b) => b.time === bucketTime)
  const nextMs = index >= 0 && index + 1 < timeline.length ? Date.parse(timeline[index + 1].time) : NaN
  return { startMs, endMs: Number.isNaN(nextMs) ? rangeEndMs : nextMs }
}

/**
 * The re-query window for a drag between two bucket times. The endpoints may
 * arrive in either order; `to` extends one interval past the later bucket so
 * that bucket's own logs are included, clamped to the investigated range end.
 * Returns ISO 8601 strings with an explicit zone (Z), which the server and the
 * time-range picker both accept as absolute times.
 */
export function computeRangeFromDrag(
  startTime: string,
  endTime: string,
  interval: string,
  rangeEndMs: number
): { fromIso: string; toIso: string } | null {
  const startMs = Date.parse(startTime)
  const endMs = Date.parse(endTime)
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return null
  }
  const fromMs = Math.min(startMs, endMs)
  const lastBucketMs = Math.max(startMs, endMs)
  const intervalMs = intervalToMs(interval)
  const inclusiveEndMs = intervalMs > 0 ? lastBucketMs + intervalMs : rangeEndMs
  // Never past the window that produced these buckets, and never degenerate.
  const toMs = Math.max(Math.min(inclusiveEndMs, rangeEndMs), fromMs + 1)
  return { fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() }
}

/**
 * Nearest bucket time for an ISO timestamp, or null when it is unparseable or
 * falls outside the charted range (bucket ±interval). The chart's x axis is
 * categorical, so overlays must land on an exact bucket value.
 */
export function snapToBucket(buckets: Array<{ time: string; ms: number }>, iso: string): string | null {
  if (buckets.length === 0) {
    return null
  }
  const ms = Date.parse(iso)
  const intervalMs = buckets.length > 1 ? buckets[1].ms - buckets[0].ms : 5 * 60_000
  if (Number.isNaN(ms) || ms < buckets[0].ms || ms > buckets[buckets.length - 1].ms + intervalMs) {
    return null
  }
  let nearest = buckets[0]
  for (const bucket of buckets) {
    if (Math.abs(bucket.ms - ms) < Math.abs(nearest.ms - ms)) {
      nearest = bucket
    }
  }
  return nearest.time
}
