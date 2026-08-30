import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import { registerPrefixedAppTool } from '../registration.js'
import { createErrorResponse } from '../utils.js'
import { getSession, investigatorResourceUri, setSession } from './runtime.js'
import { runAndStoreInvestigation, sessionResult } from './session-ops.js'
import { formatInvestigationSummary } from './summary.js'

export function registerInvestigateTool(server: McpServer): void {
  registerPrefixedAppTool(
    server,
    'investigate_logs',
    {
      title: 'Investigate Datadog Logs',
      description:
        'Open an interactive Datadog log investigation UI (timeline chart, facet breakdowns, log table). ' +
        'The user can adjust the query/time range in the UI and export a shareable HTML report. ' +
        'Returns a viewUUID and a summary. Pass a viewUUID from datadog_run_investigation to display an ' +
        'already-investigated session without re-fetching. For plain text results use datadog_search_logs.',
      inputSchema: {
        query: z.string().default('*').describe('Datadog logs search query, e.g. "service:payments status:error"'),
        from: z.string().default('now-1h').describe('Start time: Datadog time math ("now-4h") or ISO 8601'),
        to: z.string().default('now').describe('End time'),
        groupBy: z.string().optional().describe('Extra facet to break down by, e.g. "@http.status_code"'),
        title: z.string().optional().describe('Human-readable title for this investigation / report'),
        viewUUID: z
          .uuid()
          .optional()
          .describe(
            'Display an existing investigation session (from datadog_run_investigation) instead of running a new query. ' +
              'Other query params are ignored when the session exists.'
          ),
        findings: z
          .string()
          .max(20_000)
          .optional()
          .describe('Plain-text findings/notes to show in the UI findings panel and HTML report'),
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
            'Metric queries to show alongside logs (classic syntax), e.g. ["avg:system.cpu.user{service:web}"]'
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
      _meta: { ui: { resourceUri: investigatorResourceUri } },
    },
    async ({
      query,
      from,
      to,
      groupBy,
      title,
      viewUUID,
      findings,
      includeEvents,
      eventsQuery,
      metricsQueries,
      baseline,
      baselineFrom,
      baselineTo,
    }: {
      query: string
      from: string
      to: string
      groupBy?: string
      title?: string
      viewUUID?: string
      findings?: string
      includeEvents?: boolean
      eventsQuery?: string
      metricsQueries?: string[]
      baseline?: string
      baselineFrom?: string
      baselineTo?: string
    }): Promise<CallToolResult> => {
      try {
        // Display path: show an existing session without touching Datadog.
        if (viewUUID) {
          const session = getSession(viewUUID)
          if (!session) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text:
                    `Investigation session ${viewUUID} was not found (expired or server restarted). ` +
                    'Re-run datadog_run_investigation, or call datadog_investigate_logs without viewUUID.',
                },
              ],
            }
          }
          if (findings !== undefined || title !== undefined) {
            session.findings = findings ?? session.findings
            session.title = title ?? session.title
            session.updatedAt = Date.now()
            setSession(viewUUID, session)
          }
          // "viewUUID: <uuid>" is the contract with the investigator UI. Hosts
          // forward only content text (not structuredContent/_meta) to the app,
          // so the UI parses this text and pulls state via _get_view_state.
          return {
            content: [
              {
                type: 'text',
                text:
                  `${formatInvestigationSummary(sessionResult(session), viewUUID, { sampleRows: 0 })}\n` +
                  'Displaying the stored investigation session in the UI. ' +
                  'The user can refine the query and export an HTML report from the UI.',
              },
            ],
          }
        }

        const stored = await runAndStoreInvestigation({
          params: {
            query,
            from,
            to,
            groupBy,
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
        return {
          content: [
            {
              type: 'text',
              text:
                `Datadog log investigation started.\n` +
                `${formatInvestigationSummary(sessionResult(stored.session), stored.viewUUID, { sampleRows: 0 })}\n` +
                'The user can refine the query and export an HTML report from the UI. ' +
                'For model-side drill-down use datadog_search_logs / datadog_aggregate_logs.',
            },
          ],
        }
      } catch (error) {
        return createErrorResponse(error)
      }
    }
  )
}
