---
"@kajidog/mcp-datadog-logs": minor
---

Compare a log window against a baseline, and pivot faster in the investigator UI.

**New tool: `datadog_compare_windows`.** Answers "is this window actually abnormal,
and compared to what?" by measuring a target window against a baseline window. It
reports volume and error-rate deltas, the message templates that newly appeared or
spiked (and the ones that stopped), which facet values the change is concentrated
in, and when the error rate started departing — annotated with the deploy and alert
events around that moment. Baselines accept `previous` (the window immediately
before the target), `1d` / `1w`, an arbitrary shift like `4h`, `now-1d`, or explicit
`baselineFrom` / `baselineTo`. One call issues up to 13 Datadog requests (9 with the
defaults), so it is meant to be run once on a narrowed query rather than in a loop.

**Baselines on investigations.** `datadog_run_investigation` and
`datadog_investigate_logs` now take `baseline` / `baselineFrom` / `baselineTo`. The
comparison is attached to the session and appears in the model-facing summary, in a
new comparison panel in the investigator UI, and in a comparison section of the
exported HTML report. Because the target window reuses data the investigation
already fetched, it costs only about 5 extra Datadog requests. An existing session
can also be annotated after the fact by passing its `viewUUID` to
`datadog_compare_windows`.

Both surfaces are explicit about what the analysis can and cannot see: pattern
diffs are computed from the sampled rows (the most recent N per window), and facet
attribution only covers the top values Datadog returns. When either limit bites,
the result carries a `Note:` explaining it.

**New tool: `datadog_list_monitors`.** Lists monitors with their current state, how
long ago they last triggered, and the monitor query. Filter by state, tags or name,
or pass a raw Datadog monitor search query.

**Three new pivots in the investigator UI.** Clicking a row's `trace_id` chip now
expands the APM span tree inline instead of only copying the id, and traces seen
across the fetched rows are offered as a pivot strip above the table. Metric queries
can be added, edited and cleared from the UI rather than only by the model's opening
call. Dragging across the timeline re-queries the server for the dragged window
instead of filtering rows that were already fetched.
