# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

pnpm monorepo (workspaces: `apps/*`, `packages/*`) around an MCP server for investigating Datadog logs:

- `apps/mcp-datadog-logs` — `@kajidog/mcp-datadog-logs`, the published MCP server (stdio transport, tsup build)
- `packages/investigator-ui` — React UI for MCP Apps, built by Vite + `vite-plugin-singlefile` into a single `dist/mcp-app.html`
- `packages/shared` — `@kajidog/investigation-shared`, type-only wire types shared between server and UI (consumed directly from `src/`, no build step)
- `apps/datadog-pc-telemetry-sample` — standalone sample that sends PC metrics/logs to Datadog; not part of the MCP server

## Commands

```bash
pnpm install                                   # setup
pnpm build                                     # build all (UI must build before server; pnpm -r handles order)
pnpm lint                                      # biome check .
pnpm lint:fix                                  # biome check --write .
pnpm test                                      # all tests (vitest)

pnpm --filter @kajidog/mcp-datadog-logs test                                   # one package
pnpm --filter @kajidog/mcp-datadog-logs exec vitest run src/report/__tests__/generate.test.ts   # one test file
pnpm --filter @kajidog/mcp-datadog-logs exec tsc --noEmit                      # typecheck
pnpm --filter @kajidog/investigator-ui dev     # UI dev server (uses devMockApp mock data, no Datadog needed)
pnpm --filter @kajidog/investigator-ui watch   # rebuild single-file HTML on change
```

CI (`.github/workflows/ci.yml`) runs: build → assert `apps/mcp-datadog-logs/dist/mcp-app.html` exists → lint → test.

Releases use changesets: add a changeset (`pnpm changeset` or a file in `.changeset/`) for user-facing changes to `@kajidog/mcp-datadog-logs`.

## Architecture

### UI embedding chain
`investigator-ui` bundles to one self-contained `mcp-app.html`. The server's tsup `onSuccess` hook copies it into `dist/mcp-app.html`, and `src/tools/investigate/resource.ts` serves it as the MCP Apps resource `ui://datadog-logs/investigator.html` (prod: file next to the bundle; dev via the workspace link in `node_modules`). If the UI wasn't built first, the server build only warns — CI has an explicit existence check.

### viewUUID session contract
MCP hosts forward only tool-result *text* to the embedded app (no `structuredContent`), so all server↔UI data flows through JSON text plus a regex contract: tool results include `viewUUID: <uuid>` (see `VIEW_UUID_PATTERN` in `packages/shared`), and the UI extracts it in `hooks/toolClient.ts`. Full investigation results (log rows, timeline, facets, raw logs) live server-side in an in-memory LRU session store keyed by viewUUID (`tools/investigate/runtime.ts`, max 50 sessions); the model receives only a compact summary so investigations don't bloat context. UI-invoked tools (`_get_view_state`, `_run_investigation`, export, etc.) are registered in `tools/investigate/app-tools.ts`.

### Server layout (`apps/mcp-datadog-logs/src`)
- `server.ts` registers everything; `datadog/` wraps the Datadog API client (query, normalize raw logs, time parsing)
- `tools/search-logs.ts`, `tools/aggregate-logs.ts` — compact text tools for the model
- `tools/investigate/` — headless investigation (`run-investigation-tool.ts`), UI-opening tool (`investigate-tool.ts`), session ops
- `analysis/comparison.ts` + `datadog/comparison.ts` — target-vs-baseline comparison: `analysis/` is pure statistics (volume, pattern diff, facet attribution, onset detection), `datadog/` does the fetching. Sequential by design; up to 13 requests per `datadog_compare_windows` call (9 with defaults), ~5 when an investigation reuses its already-fetched target window
- `report/` — self-contained HTML report export. Log content is untrusted: every dynamic value must pass through `escapeHtml`. `styles.ts`/`script.ts` are static inline CSS/JS strings — never interpolate user data into them, and the JS must not contain a literal `</script`.

### Config
Server credentials come from env: `DD_API_KEY`, `DD_APP_KEY` (needs `logs_read_data` scope; `apm_read` for the trace tools (`datadog_get_trace`, app-only `_get_trace`), `events_read` for events, `timeseries_query` for metrics, `monitors_read` for `datadog_list_monitors` — see `docs/datadog-permissions.md`), `DD_SITE` (e.g. `ap1.datadoghq.com` for Japan), optional `DD_LOGS_INDEXES`.

Deferred security work is tracked in `docs/security-todo.md` (none of it is implemented).

## Style

Biome enforces formatting/linting: single quotes, no semicolons (`asNeeded`), 120-char lines, 2-space indent. `packages/investigator-ui/src/components/ui/` (shadcn-style primitives) is excluded from Biome. Run `pnpm lint:fix` before committing.
