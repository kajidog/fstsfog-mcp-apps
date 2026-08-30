import type {
  ComparisonResult,
  EventMarker,
  FacetAttribution,
  FacetBreakdown,
  InvestigationResult,
  LogPattern,
  LogRow,
  MetricSeries,
  OnsetEvent,
  PatternDiff,
  VolumeComparison,
} from '@kajidog/investigation-shared'
import type { RawLog } from '../datadog/normalize.js'
import { renderMarkdown } from './markdown.js'
import { REPORT_JS } from './script.js'
import { REPORT_CSS } from './styles.js'
import { renderSparklineSvg } from './svg-sparkline.js'
import { eventColor, renderTimelineSvg, stackStatuses, statusColor } from './svg-timeline.js'

const MAX_RAW_JSON_CHARS = 4_000
const KNOWN_STATUS_CLASSES = new Set(['error', 'warn', 'info', 'debug'])
const KNOWN_EVENT_CLASSES = new Set(['deploy', 'alert', 'other'])
const MAX_COMPARISON_STATUSES = 6
const MAX_COMPARISON_PATTERNS = 8
const MAX_COMPARISON_FACET_VALUES = 5
const MAX_NEARBY_ONSET_EVENTS = 3
const MAX_TEMPLATE_CHARS = 160
const COMPARISON_INTERVAL_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
/** Badge class per pattern-diff kind: looked up, never interpolated from the data. */
const PATTERN_KIND_CLASSES: Record<string, string> = {
  new: 'new',
  spiking: 'spiking',
  dropping: 'dropping',
  gone: 'gone',
}

export interface ReportOptions {
  title?: string
  site?: string
  /** IANA time zone for displayed timestamps; invalid values fall back to UTC */
  timeZone?: string
}

/**
 * Generates a self-contained single-file HTML report. Log content is
 * arbitrary user data — every dynamic value must pass through escapeHtml.
 */
export function generateReport(
  result: InvestigationResult,
  rawById: Map<string, RawLog>,
  options: ReportOptions = {}
): string {
  const title = options.title?.trim() || 'Datadog Logs Investigation'
  const { timeZone, format: formatTs } = timestampFormatter(options.timeZone ?? 'UTC')
  const generatedAt = `${formatTs(Date.now())} (${timeZone})`
  const range = `${formatTs(result.resolvedRange.fromMs)} → ${formatTs(result.resolvedRange.toMs)} (${timeZone})`

  return `<!DOCTYPE html>
<html lang="en" data-time-zone="${escapeHtml(timeZone)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        Query: <code>${escapeHtml(result.params.query)}</code><br>
        Range: ${escapeHtml(result.params.from)} → ${escapeHtml(result.params.to)} — ${escapeHtml(range)}<br>
        Generated: ${escapeHtml(generatedAt)}${options.site ? ` · Site: ${escapeHtml(options.site)}` : ''}
      </div>
    </div>
    <div class="theme-toggle" role="group" aria-label="Color theme">
      <button type="button" data-theme-value="auto">Auto</button>
      <button type="button" data-theme-value="light">Light</button>
      <button type="button" data-theme-value="dark">Dark</button>
    </div>
  </header>
  ${renderStatTiles(result)}
  ${renderComparisonSection(result.comparison, formatTs)}
  ${renderNotices(result.notices)}
  ${renderFindingsSection(result.findings)}
  ${renderTimelineSection(result, timeZone)}
  ${renderEventsSection(result.events, formatTs)}
  ${renderMetricsSection(result.metrics)}
  ${renderFacetsSection(result.facets)}
  ${renderPatternsSection(result.patterns, result.rows.length)}
  ${renderLogsSection(result, rawById, formatTs, timeZone)}
  <footer>Exported by @kajidog/mcp-datadog-logs · ${escapeHtml(result.rows.length.toString())} of ~${escapeHtml(result.totalCount.toString())} matching logs included</footer>
</main>
<script>${REPORT_JS}</script>
</body>
</html>
`
}

function renderStatTiles(result: InvestigationResult): string {
  const statusFacet = result.facets.find((f) => f.facet === 'status')
  const count = (status: string) => statusFacet?.values.find((v) => v.value === status)?.count ?? 0
  const serviceFacet = result.facets.find((f) => f.facet === 'service')
  const serviceCount = (serviceFacet?.values.length ?? 0) + (serviceFacet?.otherCount ? 1 : 0)
  const errors = count('error')
  return `<section class="tiles">
    <div class="card tile"><div class="label">Total logs</div><div class="value">${formatCount(result.totalCount)}</div></div>
    <div class="card tile"><div class="label">Errors</div><div class="value${errors > 0 ? ' error' : ''}">${formatCount(errors)}</div></div>
    <div class="card tile"><div class="label">Warnings</div><div class="value">${formatCount(count('warn'))}</div></div>
    <div class="card tile"><div class="label">Services</div><div class="value">${formatCount(serviceCount)}</div></div>
  </section>`
}

/**
 * Renders the baseline comparison above the notices: it is the headline finding
 * of an investigation that requested one. Everything here — templates, facet
 * values, event titles, the query — is log-derived, so it all goes through
 * escapeHtml, and data-dependent styling is looked up in a table with a safe
 * default rather than interpolated into markup.
 */
function renderComparisonSection(comparison: ComparisonResult | undefined, formatTs: (ms: number) => string): string {
  if (!comparison || !hasComparisonContent(comparison)) {
    return ''
  }
  const { params, target, baseline, volume } = comparison
  const mode = params.mode === 'shift' && params.shift ? `shift ${params.shift}` : params.mode
  const header =
    `Baseline: ${mode} · Target ${comparisonTime(target.fromMs, formatTs)} → ${comparisonTime(target.toMs, formatTs)}` +
    ` · Baseline ${comparisonTime(baseline.fromMs, formatTs)} → ${comparisonTime(baseline.toMs, formatTs)}` +
    ` · buckets ${comparison.interval}`
  // A large volume ratio with a flat error rate is a traffic surge, not an
  // incident; the error rate tiles sit next to the volume ones so a reader
  // cannot see one without the other.
  const errorWorse = Number.isFinite(volume.errorRateDelta) && volume.errorRateDelta > 0
  const detail = [
    renderComparisonStatuses(volume),
    renderComparisonOnset(comparison, formatTs),
    renderComparisonPatterns(comparison.patterns),
    renderComparisonFacets(comparison.facets),
    renderNotices(comparison.notices),
  ].join('')
  return `<section class="comparison">
    <h2>Baseline comparison</h2>
    <p class="compare-meta">${escapeHtml(header)}${params.scope ? ` · Pattern scope: <code>${escapeHtml(params.scope)}</code>` : ''}</p>
    <div class="tiles">
      <div class="card tile">
        <div class="label">Target logs</div>
        <div class="value">${escapeHtml(roundedCount(target.totalCount))}</div>
        <div class="sub">vs ${escapeHtml(roundedCount(baseline.totalCount))} baseline (${escapeHtml(signedCount(volume.total.delta))})</div>
      </div>
      <div class="card tile">
        <div class="label">Volume change</div>
        <div class="value">${escapeHtml(ratioText(volume.total.ratio))}</div>
        <div class="sub">target ÷ baseline</div>
      </div>
      <div class="card tile">
        <div class="label">Error rate</div>
        <div class="value${errorWorse ? ' error' : ''}">${escapeHtml(percentText(target.errorRate))}</div>
        <div class="sub">vs ${escapeHtml(percentText(baseline.errorRate))} baseline</div>
      </div>
      <div class="card tile">
        <div class="label">Error rate change</div>
        <div class="value${errorWorse ? ' error' : ''}">${escapeHtml(ratePointsText(volume.errorRateDelta))}</div>
        <div class="sub">percentage points</div>
      </div>
    </div>
    ${detail ? `<div class="card compare-detail">${detail}</div>` : ''}
  </section>`
}

/** Nothing worth showing when both windows are empty and no sub-analysis landed. */
function hasComparisonContent(comparison: ComparisonResult): boolean {
  return (
    comparison.target.totalCount > 0 ||
    comparison.baseline.totalCount > 0 ||
    comparison.onset !== undefined ||
    (comparison.patterns?.length ?? 0) > 0 ||
    (comparison.facets ?? []).some((facet) => facet.values.length > 0) ||
    (comparison.notices?.length ?? 0) > 0
  )
}

function renderComparisonStatuses(volume: VolumeComparison): string {
  const statuses = volume.byStatus
    .filter((status) => status.targetCount > 0 || status.baselineCount > 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, MAX_COMPARISON_STATUSES)
  if (statuses.length === 0) {
    return ''
  }
  const rows = statuses
    .map((status) => {
      const statusClass = KNOWN_STATUS_CLASSES.has(status.status) ? status.status : 'other'
      return `<tr>
        <td><span class="status-badge ${statusClass}">${escapeHtml(status.status)}</span></td>
        <td class="num">${escapeHtml(roundedCount(status.targetCount))}</td>
        <td class="num">${escapeHtml(roundedCount(status.baselineCount))}</td>
        <td class="num">${escapeHtml(signedCount(status.delta))}</td>
        <td class="num">${escapeHtml(ratioText(status.ratio))}</td>
      </tr>`
    })
    .join('')
  return `<div class="subsection">
    <h3>Volume by status</h3>
    <table><thead><tr><th>Status</th><th style="text-align:right">Target</th><th style="text-align:right">Baseline</th><th style="text-align:right">Delta</th><th style="text-align:right">Ratio</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </div>`
}

function renderComparisonOnset(comparison: ComparisonResult, formatTs: (ms: number) => string): string {
  const onset = comparison.onset
  if (!onset) {
    return ''
  }
  const total = comparisonBucketCount(comparison)
  const position =
    total === undefined
      ? `bucket ${roundedCount(onset.bucketIndex + 1)}`
      : `bucket ${roundedCount(onset.bucketIndex + 1)}/${roundedCount(total)}`
  const sigmas = onset.sigmas !== null && Number.isFinite(onset.sigmas) ? `, ${onset.sigmas.toFixed(1)}σ` : ''
  const tsMs = Date.parse(onset.time)
  const time = Number.isNaN(tsMs) ? onset.time : formatTs(tsMs)
  const arithmetic =
    `${position} · rate ${percentText(onset.errorRate)} vs baseline mean ${percentText(onset.baselineMean)} ` +
    `±${percentText(onset.baselineStdev)} · threshold ${percentText(onset.threshold)}${sigmas} · ` +
    `sustained ${roundedCount(onset.sustainedBuckets)} buckets`
  const events = [
    ...(onset.precedingEvent ? [{ entry: onset.precedingEvent, label: 'preceded by' }] : []),
    ...(onset.nearbyEvents ?? []).slice(0, MAX_NEARBY_ONSET_EVENTS).map((entry) => ({ entry, label: 'nearby' })),
  ]
  const eventList =
    events.length === 0
      ? ''
      : `<ul class="onset-events">${events.map(({ entry, label }) => renderOnsetEvent(entry, label, formatTs)).join('')}</ul>`
  return `<div class="subsection">
    <h3>Onset ${escapeHtml(time)}</h3>
    <p class="onset-detail">${escapeHtml(arithmetic)}</p>
    ${eventList}
  </div>`
}

function renderOnsetEvent(entry: OnsetEvent, label: string, formatTs: (ms: number) => string): string {
  const { event } = entry
  const kindClass = KNOWN_EVENT_CLASSES.has(event.kind) ? event.kind : 'other'
  const tsMs = Date.parse(event.time)
  const time = Number.isNaN(tsMs) ? event.time : formatTs(tsMs)
  // leadTimeMs is onset - event: positive means the event landed first.
  const relative = entry.leadTimeMs >= 0 ? 'before onset' : 'after onset'
  const source = event.source ? `${event.source} — ` : ''
  return `<li>
    <span class="rel">${escapeHtml(label)}</span>
    <span class="event-badge ${kindClass}">${escapeHtml(event.kind)}</span>
    <span class="time">${escapeHtml(time)}</span>
    <span class="title">${escapeHtml(source)}${escapeHtml(event.title)}</span>
    <span class="lead">${escapeHtml(`${durationText(entry.leadTimeMs)} ${relative}`)}</span>
  </li>`
}

function renderComparisonPatterns(patterns: PatternDiff[] | undefined): string {
  if (!patterns || patterns.length === 0) {
    return ''
  }
  const shown = patterns.slice(0, MAX_COMPARISON_PATTERNS)
  const rest = patterns.length - shown.length
  const rows = shown
    .map((diff) => {
      const kindClass = PATTERN_KIND_CLASSES[diff.kind] ?? 'other'
      const change =
        diff.kind === 'new'
          ? `${percentText(diff.targetRatio)} of the target sample`
          : diff.kind === 'gone'
            ? `${percentText(diff.baselineRatio)} of the baseline sample`
            : ratioText(diff.lift)
      return `<tr>
        <td><span class="diff-badge ${kindClass}">${escapeHtml(diff.kind.toUpperCase())}</span></td>
        <td class="num">~${escapeHtml(roundedCount(diff.estimatedTargetCount))}</td>
        <td class="num">~${escapeHtml(roundedCount(diff.estimatedBaselineCount))}</td>
        <td class="num">${escapeHtml(change)}</td>
        <td class="value-cell"><code>${escapeHtml(templateText(diff.template))}</code></td>
      </tr>`
    })
    .join('')
  return `<div class="subsection">
    <h3>Changed message patterns${rest > 0 ? ` (top ${escapeHtml(roundedCount(shown.length))})` : ''}</h3>
    <p class="hint">Window counts extrapolated from the sampled rows.</p>
    <table><thead><tr><th>Kind</th><th style="text-align:right">Target</th><th style="text-align:right">Baseline</th><th style="text-align:right">Change</th><th>Template</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${rest > 0 ? `<p class="hint">+${escapeHtml(roundedCount(rest))} more changed templates</p>` : ''}
  </div>`
}

function renderComparisonFacets(facets: FacetAttribution[] | undefined): string {
  return (facets ?? []).map(renderComparisonFacet).join('')
}

function renderComparisonFacet(attribution: FacetAttribution): string {
  if (attribution.values.length === 0) {
    return ''
  }
  const scale = attribution.baselineCovered > 0 ? attribution.targetCovered / attribution.baselineCovered : null
  const hint =
    scale === null
      ? 'The baseline window covers no logs, so every value is new.'
      : `Excess = occurrences beyond a uniform ${ratioText(scale)} scale-up of the baseline.`
  const shown = attribution.values.slice(0, MAX_COMPARISON_FACET_VALUES)
  const rest = attribution.values.length - shown.length
  const rows = shown
    .map((value) => {
      // baselineTruncated means the baseline's tail was cut off, so a 0 count is
      // a lower bound — calling that value new would be a claim the data cannot
      // make, which is exactly what the flag exists to prevent.
      const flag = value.baselineTruncated
        ? '<span class="flag-badge">rare in baseline</span>'
        : value.isNew
          ? '<span class="flag-badge new">NEW</span>'
          : ''
      return `<tr>
        <td class="value-cell">${escapeHtml(value.value)}${flag}</td>
        <td class="num">${escapeHtml(roundedCount(value.targetCount))}</td>
        <td class="num">${escapeHtml(roundedCount(value.baselineCount))}</td>
        <td class="num">${escapeHtml(signedCount(value.excess))}</td>
        <td class="num">${escapeHtml(percentText(value.targetShare))} vs ${escapeHtml(percentText(value.baselineShare))}</td>
      </tr>`
    })
    .join('')
  return `<div class="subsection">
    <h3>${escapeHtml(attribution.facet)} attribution</h3>
    <p class="hint">${escapeHtml(hint)}</p>
    <table><thead><tr><th>Value</th><th style="text-align:right">Target</th><th style="text-align:right">Baseline</th><th style="text-align:right">Excess</th><th style="text-align:right">Share</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${rest > 0 ? `<p class="hint">+${escapeHtml(roundedCount(rest))} more values</p>` : ''}
  </div>`
}

/** Total buckets in the target window, for "bucket 4/60"; undefined when the interval is unparseable. */
function comparisonBucketCount(comparison: ComparisonResult): number | undefined {
  const match = comparison.interval.match(/^(\d+)([smhd])$/)
  const unitMs = match ? COMPARISON_INTERVAL_UNIT_MS[match[2]] : undefined
  if (!match || unitMs === undefined) {
    return undefined
  }
  const intervalMs = Number(match[1]) * unitMs
  const span = comparison.target.toMs - comparison.target.fromMs
  if (!Number.isFinite(span) || intervalMs <= 0 || span <= 0) {
    return undefined
  }
  return Math.ceil(span / intervalMs)
}

/** Formats an epoch ms boundary, guarding the values Intl would throw on. */
function comparisonTime(ms: number, formatTs: (ms: number) => string): string {
  // 8.64e15 is the Date range limit; formatting past it throws.
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? formatTs(ms) : '(unknown)'
}

/**
 * A multiplier. `null` on the wire means the baseline side was 0 — rendering it
 * as a number would print Infinity or NaN, so it is spelled out instead.
 */
function ratioText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'new (baseline 0)'
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)}x`
}

function roundedCount(value: number): string {
  return Number.isFinite(value) ? formatCount(Math.round(value)) : '-'
}

function signedCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '-'
  }
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${formatCount(rounded)}`
}

/** A 0–1 rate as a percentage. */
function percentText(rate: number): string {
  return Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : '-'
}

/** A rate delta in percentage points, always signed. */
function ratePointsText(delta: number): string {
  if (!Number.isFinite(delta)) {
    return '-'
  }
  const pts = delta * 100
  return `${pts > 0 ? '+' : ''}${pts.toFixed(1)} pts`
}

function durationText(ms: number): string {
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

function templateText(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_TEMPLATE_CHARS ? `${collapsed.slice(0, MAX_TEMPLATE_CHARS)}…` : collapsed
}

function renderFindingsSection(findings: string | undefined): string {
  if (!findings) {
    return ''
  }
  return `<section>
    <h2>AI Findings</h2>
    <div class="card findings">${renderMarkdown(findings)}</div>
  </section>`
}

function renderTimelineSection(result: InvestigationResult, timeZone: string): string {
  const rangeMs = result.resolvedRange.toMs - result.resolvedRange.fromMs
  const events = result.events ?? []
  const svg = renderTimelineSvg(result.timeline, { rangeMs, endMs: result.resolvedRange.toMs, timeZone, events })
  const statusLegend = stackStatuses(result.timeline)
    .reverse()
    .map(
      (status) =>
        `<button type="button" class="item" data-status="${escapeHtml(status)}" aria-pressed="false"><span class="swatch" style="background:${statusColor(status)}"></span>${escapeHtml(status)}</button>`
    )
    .join('')
  const eventKinds = [...new Set(events.map((e) => e.kind))]
  const eventLegend = eventKinds
    .map(
      (kind) =>
        `<span class="item"><span class="swatch" style="background:${eventColor(kind)}"></span>${escapeHtml(kind)} event</span>`
    )
    .join('')
  const legend = statusLegend + eventLegend
  return `<section>
    <h2>Log volume (per ${escapeHtml(result.interval)})</h2>
    <div class="card timeline">
      <div class="chart-scroll">${svg}</div>
      ${legend ? `<div class="legend">${legend}</div>` : ''}
      <p class="chart-hint">Click a bar to filter the log list to that time bucket; click a legend status to filter by status. Click again to clear.</p>
    </div>
  </section>`
}

function renderNotices(notices: string[] | undefined): string {
  if (!notices || notices.length === 0) {
    return ''
  }
  return `<ul class="notices">${notices.map((notice) => `<li>${escapeHtml(notice)}</li>`).join('')}</ul>`
}

function renderEventsSection(events: EventMarker[] | undefined, formatTs: (ms: number) => string): string {
  if (!events || events.length === 0) {
    return ''
  }
  const rows = events
    .map((event) => {
      const tsMs = Date.parse(event.time)
      const time = Number.isNaN(tsMs) ? event.time : formatTs(tsMs)
      const tags = (event.tags ?? []).join(', ')
      return `<tr>
        <td class="time">${escapeHtml(time)}</td>
        <td><span class="event-badge ${escapeHtml(event.kind)}">${escapeHtml(event.kind)}</span></td>
        <td>${escapeHtml(event.source ?? '-')}</td>
        <td>${escapeHtml(event.title)}</td>
        <td class="tags">${escapeHtml(tags)}</td>
      </tr>`
    })
    .join('')
  return `<section>
    <h2>Events in window (${events.length})</h2>
    <div class="card events">
      <table><thead><tr><th>Time</th><th>Kind</th><th>Source</th><th>Title</th><th>Tags</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
  </section>`
}

function renderMetricsSection(metrics: MetricSeries[] | undefined): string {
  if (!metrics || metrics.length === 0) {
    return ''
  }
  const cards = metrics
    .map((series) => {
      const stats = series.stats
      const unit = series.unit ? ` ${escapeHtml(series.unit)}` : ''
      return `<div class="card metric-card">
        <div class="name">${escapeHtml(series.metric)}</div>
        ${series.scope ? `<div class="scope">${escapeHtml(series.scope)}</div>` : ''}
        <div class="stats">min ${formatMetricValue(stats.min)} · avg ${formatMetricValue(stats.avg)} · max ${formatMetricValue(stats.max)} · last ${stats.last === null ? '-' : formatMetricValue(stats.last)}${unit}</div>
        ${renderSparklineSvg(series.points)}
      </div>`
    })
    .join('')
  return `<section><h2>Metrics</h2><div class="metrics-grid">${cards}</div></section>`
}

function formatMetricValue(value: number): string {
  const abs = Math.abs(value)
  if (abs !== 0 && (abs >= 100000 || abs < 0.01)) {
    return value.toExponential(2)
  }
  return String(Math.round(value * 100) / 100)
}

function renderFacetsSection(facets: FacetBreakdown[]): string {
  if (facets.length === 0) {
    return ''
  }
  const cards = facets
    .map((facet) => {
      const rows = facet.values
        .map((v) => `<tr><td>${escapeHtml(v.value)}</td><td class="num">${formatCount(v.count)}</td></tr>`)
        .join('')
      const other = facet.otherCount
        ? `<tr><td>(other)</td><td class="num">${formatCount(facet.otherCount)}</td></tr>`
        : ''
      return `<div class="card">
        <h2>${escapeHtml(facet.facet)}</h2>
        <table><thead><tr><th>Value</th><th style="text-align:right">Count</th></tr></thead>
        <tbody>${rows}${other}</tbody></table>
      </div>`
    })
    .join('')
  return `<section><h2>Breakdowns</h2><div class="facets">${cards}</div></section>`
}

function renderPatternsSection(patterns: LogPattern[] | undefined, analyzedRows: number): string {
  if (!patterns || patterns.length === 0) {
    return ''
  }
  const rows = patterns
    .map(
      (pattern) =>
        `<tr><td class="num">${formatCount(pattern.count)}</td><td class="num">${Math.round(pattern.ratio * 100)}%</td><td><code>${escapeHtml(pattern.template)}</code></td></tr>`
    )
    .join('')
  return `<section>
    <h2>Message patterns (from ${formatCount(analyzedRows)} fetched rows)</h2>
    <div class="card">
      <table><thead><tr><th style="text-align:right">Count</th><th style="text-align:right">%</th><th>Template</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
  </section>`
}

function renderLogsSection(
  result: InvestigationResult,
  rawById: Map<string, RawLog>,
  formatTs: (ms: number) => string,
  timeZone: string
): string {
  const entries = result.rows.map((row) => renderLogEntry(row, rawById.get(row.id), formatTs)).join('')
  return `<section>
    <h2>Logs (${result.rows.length}) <small>— timestamps in ${escapeHtml(timeZone)}</small></h2>
    <div class="log-toolbar">
      <input id="log-search" type="search" placeholder="Filter logs by text…" aria-label="Filter logs by text">
      <span id="active-filters"></span>
      <button type="button" id="clear-filters" hidden>Clear filters</button>
      <span class="count" id="log-count"></span>
    </div>
    <div class="card logs">${entries || '<p>No log entries.</p>'}<p class="no-match" id="log-no-match" hidden>No logs match the current filters.</p></div>
  </section>`
}

function renderLogEntry(row: LogRow, raw: RawLog | undefined, formatTs: (ms: number) => string): string {
  const statusClass = KNOWN_STATUS_CLASSES.has(row.status) ? row.status : 'other'
  let detail = raw ? JSON.stringify(raw, null, 2) : JSON.stringify(row, null, 2)
  if (detail.length > MAX_RAW_JSON_CHARS) {
    detail = `${detail.slice(0, MAX_RAW_JSON_CHARS)}\n… (truncated)`
  }
  const tsMs = Date.parse(row.timestamp)
  return `<details data-status="${escapeHtml(row.status)}"${Number.isNaN(tsMs) ? '' : ` data-ts="${tsMs}"`}>
    <summary>
      <span class="time">${escapeHtml(Number.isNaN(tsMs) ? row.timestamp : formatTs(tsMs))}</span>
      <span class="status-badge ${statusClass}">${escapeHtml(row.status)}</span>
      <span class="service">${escapeHtml(row.service ?? '-')}</span>
      <span class="message">${row.traceId ? `<span class="trace-chip" title="trace_id">trace:${escapeHtml(row.traceId)}</span> ` : ''}${escapeHtml(row.message || '(no message)')}</span>
    </summary>
    <pre>${escapeHtml(detail)}</pre>
  </details>`
}

/** "YYYY-MM-DD HH:mm:ss" formatter in the given zone; invalid zones fall back to UTC. */
function timestampFormatter(timeZone: string): { timeZone: string; format: (ms: number) => string } {
  try {
    return { timeZone, format: buildTimestampFormat(timeZone) }
  } catch {
    return { timeZone: 'UTC', format: buildTimestampFormat('UTC') }
  }
}

function buildTimestampFormat(timeZone: string): (ms: number) => string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  return (ms) => {
    const byType: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
    for (const part of fmt.formatToParts(new Date(ms))) {
      byType[part.type] = part.value
    }
    return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second}`
  }
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
