/**
 * Inline stylesheet for the exported report. Palette follows the dataviz
 * reference instance: status colors are reserved for log status, chart
 * chrome/ink tokens swap between light and dark.
 *
 * Theme resolution: an explicit choice sets data-theme="light"/"dark" on
 * <html> and always wins; without it the OS preference applies.
 */
const DARK_TOKENS = `
  --surface-1: #1a1a19;
  --page: #0d0d0d;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --text-muted: #898781;
  --gridline: #2c2c2a;
  --baseline: #383835;
  --border: rgba(255, 255, 255, 0.1);
  --status-error: #d03b3b;
  --status-warn: #fab219;
  --status-info: #3987e5;
  --status-debug: #898781;
  --event-deploy: #a371f7;
  --event-alert: #f0713a;
  --event-other: #898781;
  --code-bg: #262624;
  --accent: #3987e5;
`

export const REPORT_CSS = `
:root {
  --surface-1: #fcfcfb;
  --page: #f9f9f7;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #898781;
  --gridline: #e1e0d9;
  --baseline: #c3c2b7;
  --border: rgba(11, 11, 11, 0.1);
  --status-error: #d03b3b;
  --status-warn: #fab219;
  --status-info: #2a78d6;
  --status-debug: #898781;
  --event-deploy: #8250df;
  --event-alert: #cf4a0c;
  --event-other: #898781;
  --code-bg: #f0efec;
  --accent: #2a78d6;
}
:root[data-theme="dark"] {${DARK_TOKENS}}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK_TOKENS}}
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
header h1 { font-size: 22px; margin: 0 0 4px; }
header .meta { color: var(--text-secondary); font-size: 13px; }
header .meta code {
  background: var(--code-bg);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 12px;
}
.theme-toggle {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  flex: none;
}
.theme-toggle button {
  appearance: none;
  border: none;
  background: var(--surface-1);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
}
.theme-toggle button + button { border-left: 1px solid var(--border); }
.theme-toggle button:hover { color: var(--text-primary); }
.theme-toggle button.active {
  background: var(--code-bg);
  color: var(--text-primary);
  font-weight: 600;
}
section { margin-top: 28px; }
h2 { font-size: 15px; margin: 0 0 12px; color: var(--text-primary); }
.card {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
}
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.findings { font-size: 13px; color: var(--text-secondary); overflow-wrap: anywhere; }
.findings > :first-child { margin-top: 0; }
.findings > :last-child { margin-bottom: 0; }
.findings h1, .findings h2, .findings h3 { color: var(--text-primary); margin: 14px 0 6px; }
.findings h1 { font-size: 17px; }
.findings h2 { font-size: 15px; }
.findings h3 { font-size: 14px; }
.findings p, .findings ul, .findings ol, .findings pre, .findings blockquote { margin: 8px 0; }
.findings ul, .findings ol { padding-left: 24px; }
.findings code { background: var(--code-bg); border-radius: 4px; padding: 1px 4px; font-size: 12px; }
.findings pre { background: var(--code-bg); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
.findings pre code { padding: 0; background: none; }
.findings blockquote { border-left: 3px solid var(--border); padding-left: 12px; color: var(--text-muted); }
.findings a { color: var(--accent); }
.findings table { margin: 8px 0; }
.findings del { color: var(--text-muted); }
.tile .label { color: var(--text-muted); font-size: 12px; }
.tile .value { font-size: 26px; font-weight: 600; margin-top: 2px; }
.tile .value.error { color: var(--status-error); }
.legend { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.legend .item {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
}
.legend .item:hover { background: var(--code-bg); }
.legend .item.active {
  border-color: var(--accent);
  background: var(--code-bg);
  color: var(--text-primary);
}
.legend .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.chart-hint { color: var(--text-muted); font-size: 12px; margin-top: 8px; }
.chart-scroll { overflow-x: auto; }
.timeline .bucket { cursor: pointer; }
.timeline .bucket:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.timeline.has-selection .bucket:not(.selected) rect:not(.hit) { opacity: 0.3; }
.facets { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th {
  text-align: left;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  border-bottom: 1px solid var(--gridline);
  padding: 6px 8px;
}
td { padding: 6px 8px; border-bottom: 1px solid var(--gridline); vertical-align: top; }
td.num { text-align: right; }
tr:last-child td { border-bottom: none; }
.status-badge {
  display: inline-block;
  min-width: 46px;
  text-align: center;
  border-radius: 5px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
}
.status-badge.error { background: var(--status-error); }
.status-badge.warn { background: var(--status-warn); color: #0b0b0b; }
.status-badge.info { background: var(--status-info); }
.status-badge.debug, .status-badge.other { background: var(--status-debug); }
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.log-toolbar input[type="search"] {
  flex: 1 1 220px;
  max-width: 360px;
  font: inherit;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
}
.log-toolbar input[type="search"]:focus {
  outline: none;
  border-color: var(--accent);
}
.log-toolbar .count { color: var(--text-muted); font-size: 12px; }
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--text-secondary);
}
#clear-filters {
  appearance: none;
  font: inherit;
  font-size: 12px;
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 6px;
}
#clear-filters:hover { text-decoration: underline; }
.logs details { border-bottom: 1px solid var(--gridline); }
.logs details:last-child { border-bottom: none; }
.logs details[hidden] { display: none; }
.logs summary {
  display: grid;
  grid-template-columns: 170px 64px 140px 1fr;
  gap: 10px;
  padding: 7px 8px;
  cursor: pointer;
  list-style: none;
  align-items: baseline;
}
.logs summary::-webkit-details-marker { display: none; }
.logs summary:hover { background: var(--code-bg); }
.logs summary .time { color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
.logs summary .service { color: var(--text-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.logs summary .message { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.logs .no-match { color: var(--text-muted); font-size: 13px; margin: 8px; }
.logs pre {
  background: var(--code-bg);
  border-radius: 8px;
  margin: 6px 8px 12px;
  padding: 12px;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.45;
}
.event-badge {
  display: inline-block;
  min-width: 46px;
  text-align: center;
  border-radius: 5px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
}
.event-badge.deploy { background: var(--event-deploy); }
.event-badge.alert { background: var(--event-alert); }
.event-badge.other { background: var(--event-other); }
.events td.time { white-space: nowrap; color: var(--text-secondary); font-size: 12px; }
.events td.tags { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.metric-card .name { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.metric-card .scope { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
.metric-card .stats {
  color: var(--text-secondary);
  font-size: 12px;
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}
.metric-card svg { display: block; width: 100%; height: auto; margin-top: 8px; }
.notices { color: var(--text-muted); font-size: 12px; margin-top: 10px; }
.notices li { margin: 2px 0; }
.trace-chip {
  background: var(--code-bg);
  border-radius: 4px;
  padding: 0 5px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-secondary);
}
.comparison .compare-meta { color: var(--text-secondary); font-size: 13px; margin: 0 0 12px; }
.comparison .compare-meta code { background: var(--code-bg); border-radius: 4px; padding: 1px 6px; font-size: 12px; }
.comparison .tiles { margin-bottom: 12px; }
.tile .sub { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
.compare-detail > .subsection + .subsection { margin-top: 20px; }
.compare-detail h3 { font-size: 13px; margin: 0 0 6px; color: var(--text-primary); }
.compare-detail .hint { color: var(--text-muted); font-size: 12px; margin: 0 0 8px; }
.compare-detail .onset-detail { color: var(--text-secondary); font-size: 13px; margin: 0; }
.compare-detail .value-cell { overflow-wrap: anywhere; }
.compare-detail .value-cell code { background: var(--code-bg); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.compare-detail .notices { margin-top: 16px; padding-left: 18px; }
.onset-events { list-style: none; margin: 10px 0 0; padding: 0; font-size: 13px; }
.onset-events li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 3px 0;
}
.onset-events .rel { color: var(--text-muted); font-size: 12px; min-width: 76px; }
.onset-events .time { color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
.onset-events .title { overflow-wrap: anywhere; }
.onset-events .lead { color: var(--text-muted); font-size: 12px; }
.diff-badge {
  display: inline-block;
  min-width: 66px;
  text-align: center;
  border-radius: 5px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
}
.diff-badge.new { background: var(--status-error); }
.diff-badge.spiking { background: var(--event-alert); }
.diff-badge.dropping { background: var(--status-info); }
.diff-badge.gone, .diff-badge.other { background: var(--status-debug); }
.flag-badge {
  display: inline-block;
  margin-left: 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--code-bg);
}
.flag-badge.new { color: var(--status-error); border-color: var(--status-error); }
footer { margin-top: 40px; color: var(--text-muted); font-size: 12px; }
@media print {
  body { background: #fff; }
  .card { border: 1px solid #ddd; }
  .logs summary .message { white-space: normal; }
  .theme-toggle, .log-toolbar, .chart-hint { display: none; }
}
`
