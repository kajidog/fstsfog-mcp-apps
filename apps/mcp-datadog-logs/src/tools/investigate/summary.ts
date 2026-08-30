import type { EventMarker, InvestigationResult, LogRow, TimelineBucket } from '@kajidog/investigation-shared'
import { formatComparisonLines } from '../comparison-summary.js'
import { formatMetricStatsLine } from '../query-metrics.js'

export interface SummaryOptions {
  /** Sample log lines to inline (0 = none) */
  sampleRows?: number
  /** Top values shown per facet */
  topFacetValues?: number
  /** Top message patterns to inline (0 = none) */
  topPatterns?: number
}

export const MAX_SAMPLE_MESSAGE_LENGTH = 200
const MAX_PATTERN_TEMPLATE_LENGTH = 120

/**
 * Compact, model-facing summary of an investigation. The first line carries
 * the `viewUUID: <uuid>` contract (VIEW_UUID_PATTERN) that the investigator
 * UI extracts from tool result text, so it must stay on line one.
 */
export function formatInvestigationSummary(
  result: InvestigationResult,
  viewUUID: string,
  opts: SummaryOptions = {}
): string {
  const { sampleRows = 3, topFacetValues = 3, topPatterns = 5 } = opts
  const lines: string[] = [`viewUUID: ${viewUUID}`]
  lines.push(`Query: ${result.params.query} | Range: ${result.params.from} → ${result.params.to}`)

  const statusFacet = result.facets.find((f) => f.facet === 'status')
  const statusCounts = (statusFacet?.values ?? []).map((v) => `${v.value}: ${v.count.toLocaleString('en-US')}`)
  lines.push(
    `Total: ~${result.totalCount.toLocaleString('en-US')} logs` +
      (statusCounts.length > 0 ? ` — ${statusCounts.join(', ')}` : '')
  )

  for (const facet of result.facets) {
    if (facet.facet === 'status' || facet.values.length === 0) {
      continue
    }
    const shown = facet.values.slice(0, topFacetValues)
    const top = shown.map((v) => `${v.value} (${v.count.toLocaleString('en-US')})`).join(', ')
    const restValues = facet.values.length - shown.length
    const more = restValues > 0 ? ` +${restValues} more` : ''
    const other = facet.otherCount ? `, (other) ${facet.otherCount.toLocaleString('en-US')}` : ''
    lines.push(`${facet.facet}: ${top}${more}${other}`)
  }

  // Every comparison line is inside this guard: a result without a comparison
  // must render byte-for-byte as it did before the field existed.
  if (result.comparison) {
    // compact: the query and the target range are already on the lines above.
    lines.push(...formatComparisonLines(result.comparison, { compact: true }))
  }

  const events = result.events ?? []
  if (events.length > 0) {
    const shown = events.slice(0, 5)
    const rest = events.length - shown.length
    lines.push(`Events in window (${events.length})${rest > 0 ? `, first ${shown.length}` : ''}:`)
    const nearSpike = eventsNearErrorSpike(events, result.timeline)
    for (const event of shown) {
      lines.push(`  ${formatEventMarkerLine(event)}${nearSpike.has(event.id) ? ' (near error spike)' : ''}`)
    }
  }

  const metrics = result.metrics ?? []
  if (metrics.length > 0) {
    const shown = metrics.slice(0, 6)
    const rest = metrics.length - shown.length
    lines.push(`Metrics${rest > 0 ? ` (${shown.length} of ${metrics.length} series)` : ''}:`)
    for (const series of shown) {
      lines.push(`  ${formatMetricStatsLine(series)}`)
    }
  }

  const traceCandidates = result.traceCandidates ?? []
  if (traceCandidates.length > 0) {
    lines.push('Trace candidates (from stored rows):')
    for (const candidate of traceCandidates) {
      const services = candidate.services.length > 0 ? ` services=${candidate.services.join(',')}` : ''
      lines.push(
        `  ${candidate.traceId} — ${candidate.count} rows (${candidate.errorCount} errors)${services}` +
          ` → datadog_get_trace trace_id=${candidate.traceId}`
      )
    }
  }

  for (const notice of result.notices ?? []) {
    lines.push(`Note: ${notice}`)
  }

  const patterns = result.patterns ?? []
  if (topPatterns > 0 && patterns.length > 0) {
    const shown = patterns.slice(0, topPatterns)
    const rest = patterns.length - shown.length
    lines.push(`Top patterns (of ${result.rows.length} fetched rows)${rest > 0 ? ` +${rest} more` : ''}:`)
    shown.forEach((pattern, i) => {
      let template = pattern.template.replace(/\s+/g, ' ').trim()
      if (template.length > MAX_PATTERN_TEMPLATE_LENGTH) {
        template = `${template.slice(0, MAX_PATTERN_TEMPLATE_LENGTH)}…`
      }
      lines.push(
        `  #${i + 1} ${pattern.count.toLocaleString('en-US')} (${Math.round(pattern.ratio * 100)}%) ${template}`
      )
    })
  }

  if (sampleRows > 0 && result.rows.length > 0) {
    const samples = pickSampleRows(result.rows, sampleRows)
    lines.push(`Sample logs (${samples.length} of ${result.rows.length} stored, errors first):`)
    for (const { row, index } of samples) {
      lines.push(formatSampleLine(row, index))
    }
  } else if (result.rows.length > 0) {
    lines.push(`${result.rows.length} log rows stored in the session.`)
  }

  if (result.nextCursor) {
    lines.push(`nextCursor: ${result.nextCursor}`)
  }
  return lines.join('\n')
}

function formatEventMarkerLine(event: EventMarker): string {
  const parts = [event.time, `[${event.kind}]`, event.source ? `${event.source} —` : undefined, event.title]
  return parts.filter(Boolean).join(' ')
}

/**
 * Ids of events within one timeline interval of the bucket with the most
 * errors — the "what changed right around the spike" callout.
 */
function eventsNearErrorSpike(events: EventMarker[], timeline: TimelineBucket[]): Set<string> {
  if (timeline.length === 0) {
    return new Set()
  }
  let peak: TimelineBucket | undefined
  let peakErrors = 0
  for (const bucket of timeline) {
    const errors = bucket.counts.error ?? 0
    if (errors > peakErrors) {
      peakErrors = errors
      peak = bucket
    }
  }
  if (!peak) {
    return new Set()
  }
  const bucketMs =
    timeline.length > 1 ? new Date(timeline[1].time).getTime() - new Date(timeline[0].time).getTime() : 5 * 60 * 1000
  const peakMs = new Date(peak.time).getTime()
  const near = new Set<string>()
  for (const event of events) {
    const eventMs = new Date(event.time).getTime()
    // Bucket time is the interval start: the spike spans [peak, peak+bucket],
    // and we include one interval of slack on both sides.
    if (!Number.isNaN(eventMs) && eventMs >= peakMs - bucketMs && eventMs <= peakMs + 2 * bucketMs) {
      near.add(event.id)
    }
  }
  return near
}

/**
 * Picks sample rows for the summary: error rows first, then warn, then the
 * rest, each group in stored order. Keeps the absolute index into
 * `result.rows` so samples can be referenced as `row=<N>` in
 * datadog_get_session_logs.
 */
function pickSampleRows(rows: LogRow[], count: number): Array<{ row: LogRow; index: number }> {
  const indexed = rows.map((row, index) => ({ row, index }))
  const rank = (status: string): number => (status === 'error' ? 0 : status === 'warn' ? 1 : 2)
  return indexed.sort((a, b) => rank(a.row.status) - rank(b.row.status) || a.index - b.index).slice(0, count)
}

/**
 * One compact text line for a stored log row. `index` is the row's absolute
 * position in the session's rows array — the `[N]` reference accepted as
 * `row` by datadog_get_session_logs.
 */
export function formatSampleLine(row: LogRow, index?: number): string {
  let message = row.message.replace(/\s+/g, ' ').trim() || '(no message)'
  if (message.length > MAX_SAMPLE_MESSAGE_LENGTH) {
    message = `${message.slice(0, MAX_SAMPLE_MESSAGE_LENGTH)}…`
  }
  const parts = [
    index === undefined ? undefined : `[${index}]`,
    row.timestamp,
    `[${row.status.toUpperCase()}]`,
    row.service ?? '-',
    row.host ? `host=${row.host}` : undefined,
    '—',
    message,
  ]
  return parts.filter(Boolean).join(' ')
}
