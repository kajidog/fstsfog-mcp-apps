# @kajidog/mcp-datadog-logs

MCP server for investigating **Datadog logs** with AI — including an interactive
**MCP Apps UI** (timeline chart, facet breakdowns, log table) rendered directly in
MCP Apps-capable hosts such as Claude, and one-click export to a **self-contained
HTML report** you can share with your team (print it to PDF from the browser if
needed).

## Features

- 🔎 `datadog_search_logs` — quick log search for the model (compact text output)
- 📊 `datadog_aggregate_logs` — counts by facet or timeseries for the model
- 📈 `datadog_query_metrics` — metric timeseries for the model (classic query
  syntax, per-series stats + downsampled values as compact text)
- 🚨 `datadog_list_monitors` — monitors and their current state for the model
  (state / tag / name filters or a raw Datadog monitor search query; one line per
  monitor with status, last trigger age and the monitor query)
- 🕵️ `datadog_run_investigation` — headless investigation for the model:
  - full result (log rows, timeline, facets) stored server-side under a `viewUUID`
  - the model receives only a compact summary — iterate without bloating context
  - pass the `viewUUID` to `datadog_investigate_logs` to display it, with optional
    Markdown `findings` rendered in the UI and the HTML report
- 🔗 cross-source investigation — the investigation tools also fetch Datadog
  **events** (deploys, alerts) in the same window and optional **metrics**
  (`metricsQueries`), overlay them on the timeline (UI + HTML report), and
  surface **trace candidates** extracted from the fetched rows so the model can
  pivot straight into `datadog_get_trace`; missing `events_read` /
  `timeseries_query` scopes degrade gracefully instead of failing the run
- 🔬 `datadog_get_session_logs` — drill into a stored session with **zero extra
  Datadog API calls**: filter the stored rows by status / service / message
  pattern `#N` / substring, or fetch one full raw log by `row=[N]` index or
  `logId` (with `fields` to select attribute paths on large logs)
- 📄 `datadog_export_report` — export directly from the model:
  - pass a `viewUUID` to write the self-contained HTML report to disk without opening the UI
  - `format: 'csv' | 'json'` writes the fetched log rows as data instead
- 🧩 automatic message pattern analysis — fetched rows are clustered into
  templates (`Payment failed for order <*>`), surfaced in tool summaries, the UI
  and HTML reports
- 🖥️ `datadog_investigate_logs` — opens the interactive investigation UI:
  - stacked timeline chart of log volume by status, with deploy/alert event markers
  - event list (click an event to filter logs to its time bucket) and a metrics panel
  - facet sidebar (service / status / host / custom `groupBy`) — click to filter
  - message pattern panel — fetched rows clustered into templates, click to filter
  - log table with expandable full-JSON detail, copyable `trace_id` chips, keyword highlighting and load-more pagination
  - adjust query & time range and re-run right from the UI
  - **Export** button → self-contained HTML report, plus CSV/JSON export of the filtered rows
- stdio transport; investigation sessions are cached in memory and mirrored to
  a local cache directory so a `viewUUID` survives server restarts

## Setup

Requires Node.js >= 20 and a Datadog API key + application key
(the application key needs the `logs_read_data` scope; add `apm_read` for
`datadog_get_trace`, `events_read` for `datadog_search_events`,
`timeseries_query` for `datadog_query_metrics`, and `monitors_read` for
`datadog_list_monitors`).

### Claude Code

```bash
claude mcp add datadog-logs \
  -e DD_API_KEY=<your-api-key> \
  -e DD_APP_KEY=<your-app-key> \
  -e DD_SITE=ap1.datadoghq.com \
  -- npx -y @kajidog/mcp-datadog-logs
```

### Claude Desktop (claude_desktop_config.json)

```json
{
  "mcpServers": {
    "datadog-logs": {
      "command": "npx",
      "args": ["-y", "@kajidog/mcp-datadog-logs"],
      "env": {
        "DD_API_KEY": "<your-api-key>",
        "DD_APP_KEY": "<your-app-key>",
        "DD_SITE": "ap1.datadoghq.com"
      }
    }
  }
}
```

Then ask: *"Investigate error logs for the payments service in the last 4 hours"*.

### MCP Inspector

```bash
DD_SITE=ap1.datadoghq.com \
DD_API_KEY=<your-api-key> \
DD_APP_KEY=<your-app-key> \
npx @modelcontextprotocol/inspector node apps/mcp-datadog-logs/dist/index.js
```

Use the same `DD_SITE` as the Datadog org where the API key and application key
were created. Japan is `ap1.datadoghq.com`; US1 is `datadoghq.com`.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DD_API_KEY` | ✅ | — | Datadog API key |
| `DD_APP_KEY` | ✅ | — | Datadog application key from the same org/site as `DD_API_KEY` (`logs_read_data` scope; `apm_read` / `events_read` / `timeseries_query` / `monitors_read` for the trace, events, metrics and monitors tools) |
| `DD_SITE` | | `datadoghq.com` | Datadog site, e.g. `ap1.datadoghq.com`, `datadoghq.eu`, `us5.datadoghq.com` |
| `DD_LOGS_INDEXES` | | all | Comma-separated log indexes to search |
| `MCP_DATADOG_EXPORT_DIR` | | `~/Downloads` (or cwd) | Where exported reports / data files are written |
| `MCP_DATADOG_MAX_ROWS` | | `200` | Max log rows per investigation (hard cap 500) |
| `MCP_DATADOG_TIMEZONE` | | `UTC` | IANA time zone (e.g. `Asia/Tokyo`) for timestamps in exported HTML reports; invalid values fall back to UTC |
| `MCP_DATADOG_SESSION_DIR` | | `~/.cache/mcp-datadog-logs/sessions` | Where investigation sessions are persisted across restarts (pruned beyond 50 files / 7 days) |
| `MCP_DATADOG_PERSIST_SESSIONS` | | `true` | Set `false` to keep sessions in memory only |

Required Datadog permissions are documented in
[`docs/datadog-permissions.md`](../../docs/datadog-permissions.md).

## Tools

| Tool | Audience | Description |
|---|---|---|
| `datadog_search_logs` | model | Search logs, compact text lines + pagination cursor. `dedupe: true` clusters the fetched page into message patterns (one line per pattern) |
| `datadog_aggregate_logs` | model | Count by facet (`groupBy`), or as a timeseries when `interval` is set (per-facet counts per bucket) |
| `datadog_get_trace` | model | Render one APM trace as a parent/child span tree. Runs of identical leaf siblings collapse into one `xN` line (`collapse: false` to disable); `errors_only` renders just error spans + their ancestors; `max_spans` caps the output |
| `datadog_search_events` | model | Search Datadog events (deployments, monitor alerts, config changes) as a compact timeline; `max_tags: 0` hides tags |
| `datadog_query_metrics` | model | Query metric timeseries with the classic syntax (`avg:system.cpu.user{service:web} by {host}`); per-series stats + downsampled values, `max_series` caps group-by fan-out |
| `datadog_list_monitors` | model | List monitors with state, last trigger age and query. Filter by `state` (`alert` / `warn` / `no data` / `ok` / `all`, aliases accepted), `tags`, `name` — or pass a raw monitor search `query` (which overrides the three). `sort` by `status`, `name` or `last_triggered` |
| `datadog_run_investigation` | model | Headless investigation stored in a server-side session; returns a compact summary + `viewUUID`. Iterate on the same `viewUUID`, load more rows with `cursor`, attach `findings`. Also fetches events in the window (`includeEvents` / `eventsQuery`) and metrics (`metricsQueries`), and lists trace candidates extracted from the fetched rows |
| `datadog_get_session_logs` | model | Read rows already stored under a `viewUUID` — no Datadog API call. List mode filters by `status` / `service` / `pattern` (the summary's `#N`) / `contains` with `offset`/`limit`; detail mode (`row` or `logId`) returns one full raw log, with `fields` to select attribute paths |
| `datadog_export_report` | model | Write a `viewUUID` session to `MCP_DATADOG_EXPORT_DIR` as a self-contained HTML report, or as CSV/JSON of the fetched rows (`format`) — no UI needed |
| `datadog_investigate_logs` | model → UI | Run a full investigation and open the interactive UI. Pass a `viewUUID` from `datadog_run_investigation` to display that session without re-fetching |
| `_get_view_state` / `_run_investigation` / `_get_log_detail` / `_export_report` | UI only | Internal bridge tools called by the app (hidden from the model) |

`from`/`to` accept Datadog time math (`now-4h`, `now`) or ISO 8601. Absolute
timestamps must include an explicit time zone (`Z` or an offset like `+09:00`);
values without one (e.g. `2026-07-12T10:00:00`) are rejected as ambiguous.

`datadog_run_investigation` summaries number message patterns (`#1`…) and
prefix sample rows with their stored index (`[N]`); both are stable handles for
`datadog_get_session_logs` (`pattern: 1`, `row: N`). Indexes stay valid across
`cursor` load-more but reset when the same `viewUUID` is re-run with a new
query.

## Exported reports

`Export` in the UI — or the `datadog_export_report` tool, when you ask the model
to export a report directly — writes a single `.html` file (inline CSS + SVG
chart, no external requests) to `MCP_DATADOG_EXPORT_DIR` and asks the OS to open
it in the default browser. If the server is running in a headless or remote
environment, the file is still written and the saved path is reported. Use the
browser's *Print → Save as PDF* for a PDF copy.

Report timestamps are rendered in `MCP_DATADOG_TIMEZONE` (default UTC).

## Rate limits

Datadog APIs can return `429 Too Many Requests` when an endpoint's rate limit is
exceeded. This server enables the Datadog SDK retry behavior for 429/5xx
responses and runs the multi-request investigation pipeline sequentially to avoid
request bursts.

If 429 still occurs, wait for the Datadog rate-limit window to reset and retry
with a narrower time range or fewer repeated UI refreshes.

## License

MIT
