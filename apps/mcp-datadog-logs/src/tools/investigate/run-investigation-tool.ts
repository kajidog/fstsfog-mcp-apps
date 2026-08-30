import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import { HARD_MAX_ROWS } from '../../config.js'
import { registerPrefixedTool } from '../registration.js'
import { createErrorResponse, textResult } from '../utils.js'
import { runAndStoreInvestigation, sessionResult } from './session-ops.js'
import { formatInvestigationSummary } from './summary.js'

export function registerRunInvestigationTool(server: McpServer): void {
  registerPrefixedTool(
    server,
    'run_investigation',
    {
      title: 'Run Datadog Log Investigation (no UI)',
      description:
        'Run a log investigation (log page + status timeline + facet breakdowns) WITHOUT opening a UI. ' +
        'The full result is stored server-side under a viewUUID; only a compact summary is returned. ' +
        'Pass the same viewUUID to iterate on one session (refine the query, or load more rows with cursor), ' +
        'then call datadog_investigate_logs with the viewUUID to display the session to the user. ' +
        'Sessions are cached in memory and mirrored to disk, so a viewUUID usually survives server restarts.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Datadog logs search query (default: "*"; inherited when continuing with viewUUID + cursor)'),
        from: z
          .string()
          .optional()
          .describe('Start time: Datadog time math or ISO 8601 (default: "now-1h"; inherited for cursor continuation)'),
        to: z.string().optional().describe('End time (default: "now"; inherited for cursor continuation)'),
        groupBy: z.string().optional().describe('Extra facet to break down by, e.g. "@http.status_code"'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(HARD_MAX_ROWS)
          .optional()
          .describe('Max log rows to fetch and store in the session (not returned to you)'),
        viewUUID: z
          .uuid()
          .optional()
          .describe('Existing investigation session to update/iterate on; omit to create a new one'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous summary — appends the next page of rows (requires viewUUID)'),
        sampleRows: z
          .number()
          .int()
          .min(0)
          .max(20)
          .default(3)
          .describe('How many sample log lines to include in the summary'),
        findings: z
          .string()
          .max(20_000)
          .optional()
          .describe(
            'Plain-text findings/notes to attach to the session; shown in the UI and HTML report. Replaces previous findings.'
          ),
        title: z.string().optional().describe('Human-readable title for this investigation / report'),
        includeEvents: z
          .boolean()
          .optional()
          .describe(
            'Also fetch Datadog events (deploys, alerts) in the window and overlay them on the timeline (default true)'
          ),
        eventsQuery: z
          .string()
          .optional()
          .describe('Events search query, e.g. "source:github tags:service:web" (default: all events in the window)'),
        metricsQueries: z
          .array(z.string())
          .max(4)
          .optional()
          .describe(
            'Metric queries to fetch alongside logs (classic syntax), e.g. ' +
              '["avg:system.cpu.user{service:web}", "avg:trace.express.request.duration{service:web}"]'
          ),
        baseline: z
          .string()
          .optional()
          .describe(
            'Also compare the window against a baseline window and include the deltas in the summary: "previous" ' +
              '(the window immediately before the target), a shift back by the same duration ("1d", "1w"), or a ' +
              'time-math start ("now-1d"). Costs ~5 extra Datadog requests, so ask for it to establish whether the ' +
              'window is abnormal — not on every run.'
          ),
        baselineFrom: z
          .string()
          .optional()
          .describe(
            'Explicit baseline window start; overrides "baseline" and is honoured on its own (baselineTo then ' +
              "defaults to a window of the target's length). Same ~5 extra Datadog requests."
          ),
        baselineTo: z
          .string()
          .optional()
          .describe('Explicit baseline window end; honoured on its own. Same ~5 extra Datadog requests.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({
      query,
      from,
      to,
      groupBy,
      limit,
      viewUUID,
      cursor,
      sampleRows,
      findings,
      title,
      includeEvents,
      eventsQuery,
      metricsQueries,
      baseline,
      baselineFrom,
      baselineTo,
    }: {
      query?: string
      from?: string
      to?: string
      groupBy?: string
      limit?: number
      viewUUID?: string
      cursor?: string
      sampleRows: number
      findings?: string
      title?: string
      includeEvents?: boolean
      eventsQuery?: string
      metricsQueries?: string[]
      baseline?: string
      baselineFrom?: string
      baselineTo?: string
    }): Promise<CallToolResult> => {
      try {
        if (cursor && !viewUUID) {
          return createErrorResponse(new Error('cursor requires viewUUID (load-more appends to an existing session)'))
        }
        const stored = await runAndStoreInvestigation({
          viewUUID,
          params: {
            query,
            from,
            to,
            groupBy,
            limit,
            cursor,
            title,
            includeEvents,
            eventsQuery,
            metricsQueries,
            baseline,
            baselineFrom,
            baselineTo,
          },
          findings,
        })
        const summary = formatInvestigationSummary(sessionResult(stored.session), stored.viewUUID, { sampleRows })
        return textResult(
          `${summary}\n` +
            'Drill down without new Datadog calls: datadog_get_session_logs with this viewUUID ' +
            '(filters: status/service/pattern=N/contains; row=N or logId for one full log). ' +
            'Call this tool again with the same viewUUID to refine or load more (cursor), ' +
            'or call datadog_investigate_logs with this viewUUID to display it to the user.'
        )
      } catch (error) {
        return createErrorResponse(error)
      }
    }
  )
}
