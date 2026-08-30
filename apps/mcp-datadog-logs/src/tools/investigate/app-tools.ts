import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import { HARD_MAX_ROWS } from '../../config.js'
import { getDatadogClient } from '../../datadog/client.js'
import { formatTrace } from '../get-trace.js'
import { registerPrefixedAppTool } from '../registration.js'
import { createErrorResponse, jsonResult } from '../utils.js'
import { exportInvestigationReport } from './export-report.js'
import { getSession, investigatorResourceUri } from './runtime.js'
import { runAndStoreInvestigation, sessionResult } from './session-ops.js'

/**
 * Spans of a trace can start before, and end after, the log line that carried
 * the trace id, so the session's resolved window is padded on both sides.
 */
const TRACE_RANGE_PAD_MS = 30 * 60_000

const appOnlyMeta = {
  ui: {
    resourceUri: investigatorResourceUri,
    visibility: ['app'],
  },
} as const

export function registerInvestigateAppTools(server: McpServer): void {
  registerPrefixedAppTool(
    server,
    '_get_view_state',
    {
      title: 'Get Investigation State (App)',
      description: 'Fetch the stored investigation result for a viewUUID. Only callable from the app UI.',
      inputSchema: {
        viewUUID: z.uuid().describe('Investigation view ID from the tool result text'),
      },
      _meta: appOnlyMeta,
    },
    async ({ viewUUID }: { viewUUID: string }): Promise<CallToolResult> => {
      const session = getSession(viewUUID)
      if (!session) {
        // State can be lost on server restart. Return notFound (not an error)
        // so the UI can show a "session expired" message.
        return jsonResult({ notFound: true })
      }
      return jsonResult(sessionResult(session))
    }
  )

  registerPrefixedAppTool(
    server,
    '_run_investigation',
    {
      title: 'Run Investigation (App)',
      description:
        'Re-run the investigation with adjusted parameters and update the stored view state. Only callable from the app UI.',
      inputSchema: {
        viewUUID: z.uuid().describe('Investigation view ID to update'),
        query: z.string().describe('Datadog logs search query'),
        from: z.string().describe('Start time (Datadog time math or ISO 8601)'),
        to: z.string().describe('End time'),
        groupBy: z.string().optional().describe('Extra facet to break down by'),
        limit: z.number().int().min(1).max(HARD_MAX_ROWS).optional().describe('Max log rows'),
        cursor: z.string().optional().describe('Pagination cursor — appends the next page of rows to the view'),
        includeEvents: z.boolean().optional().describe('Fetch Datadog events for the window (inherited when omitted)'),
        eventsQuery: z.string().optional().describe('Events search query (inherited when omitted)'),
        metricsQueries: z
          .array(z.string())
          .max(4)
          .optional()
          .describe('Metric queries to fetch alongside logs (inherited when omitted)'),
        baseline: z
          .string()
          .optional()
          .describe(
            'Baseline window to compare against ("previous", a shift like "1d"/"1w", or a time-math start); ' +
              'costs ~5 extra Datadog requests (inherited when omitted)'
          ),
        baselineFrom: z
          .string()
          .optional()
          .describe('Explicit baseline start; overrides "baseline". Same ~5 extra requests (inherited when omitted)'),
        baselineTo: z
          .string()
          .optional()
          .describe('Explicit baseline end; honoured on its own. Same ~5 extra requests (inherited when omitted)'),
      },
      _meta: appOnlyMeta,
    },
    async ({
      viewUUID,
      query,
      from,
      to,
      groupBy,
      limit,
      cursor,
      includeEvents,
      eventsQuery,
      metricsQueries,
      baseline,
      baselineFrom,
      baselineTo,
    }: {
      viewUUID: string
      query: string
      from: string
      to: string
      groupBy?: string
      limit?: number
      cursor?: string
      includeEvents?: boolean
      eventsQuery?: string
      metricsQueries?: string[]
      baseline?: string
      baselineFrom?: string
      baselineTo?: string
    }): Promise<CallToolResult> => {
      try {
        // No findings arg: existing findings are preserved across UI re-runs.
        const { session } = await runAndStoreInvestigation({
          viewUUID,
          params: {
            query,
            from,
            to,
            groupBy,
            limit,
            cursor,
            includeEvents,
            eventsQuery,
            metricsQueries,
            baseline,
            baselineFrom,
            baselineTo,
          },
        })
        return jsonResult(sessionResult(session))
      } catch (error) {
        return createErrorResponse(error)
      }
    }
  )

  registerPrefixedAppTool(
    server,
    '_get_log_detail',
    {
      title: 'Get Log Detail (App)',
      description: 'Fetch the full raw log event for a row in the investigation table. Only callable from the app UI.',
      inputSchema: {
        viewUUID: z.uuid().describe('Investigation view ID'),
        logId: z.string().describe('Log row ID'),
      },
      _meta: appOnlyMeta,
    },
    async ({ viewUUID, logId }: { viewUUID: string; logId: string }): Promise<CallToolResult> => {
      const session = getSession(viewUUID)
      if (!session) {
        return jsonResult({ notFound: true })
      }
      const raw = session.rawById.get(logId)
      if (!raw) {
        return jsonResult({ notFound: true })
      }
      return jsonResult(raw)
    }
  )

  registerPrefixedAppTool(
    server,
    '_get_trace',
    {
      title: 'Get Trace (App)',
      description:
        "Render the APM trace behind a trace_id seen on this investigation's rows. Only callable from the app UI.",
      inputSchema: {
        viewUUID: z.uuid().describe('Investigation view ID'),
        traceId: z.string().min(1).describe('APM trace ID carried by a stored row or a trace candidate'),
        errorsOnly: z.boolean().optional().describe('Render only error spans and their ancestor chains'),
        maxSpans: z.number().int().min(10).max(300).optional().describe('Max tree lines to render'),
      },
      _meta: appOnlyMeta,
    },
    async ({
      viewUUID,
      traceId,
      errorsOnly,
      maxSpans,
    }: {
      viewUUID: string
      traceId: string
      errorsOnly?: boolean
      maxSpans?: number
    }): Promise<CallToolResult> => {
      const session = getSession(viewUUID)
      if (!session) {
        return jsonResult({ notFound: true })
      }
      // The window comes from the session, and the trace id must belong to it:
      // without both checks this app tool would be a general-purpose trace-fetch
      // proxy for any id and any range the client cares to send.
      const known =
        session.result.rows.some((row) => row.traceId === traceId) ||
        (session.result.traceCandidates ?? []).some((candidate) => candidate.traceId === traceId)
      if (!known) {
        return jsonResult({ notFound: true })
      }
      const from = new Date(session.result.resolvedRange.fromMs - TRACE_RANGE_PAD_MS).toISOString()
      const to = new Date(session.result.resolvedRange.toMs + TRACE_RANGE_PAD_MS).toISOString()
      try {
        const { spans, truncated } = await getDatadogClient().listTraceSpans({ traceId, from, to, maxSpans })
        // Same renderer as datadog_get_trace, so the UI shows exactly what the model sees.
        const tree =
          spans.length > 0
            ? formatTrace(traceId, spans, { fetchTruncated: truncated, errorsOnly, maxSpans })
            : `No spans found for trace_id "${traceId}" between ${from} and ${to}. ` +
              'Indexed spans are only searchable within their retention window.'
        return jsonResult({ traceId, tree })
      } catch (error) {
        return createErrorResponse(error, 'apm_read')
      }
    }
  )

  registerPrefixedAppTool(
    server,
    '_export_report',
    {
      title: 'Export Investigation Report (App)',
      description:
        'Export the investigation to the export directory as an HTML report (default) or CSV/JSON of the fetched rows. Only callable from the app UI.',
      inputSchema: {
        viewUUID: z.uuid().describe('Investigation view ID'),
        title: z.string().optional().describe('Report title override'),
        format: z.enum(['html', 'csv', 'json']).optional().describe('Output format (default "html")'),
        rowIds: z
          .array(z.string())
          .max(HARD_MAX_ROWS)
          .optional()
          .describe('csv/json only: export just these stored rows (e.g. the filtered view)'),
      },
      _meta: appOnlyMeta,
    },
    async ({
      viewUUID,
      title,
      format,
      rowIds,
    }: {
      viewUUID: string
      title?: string
      format?: 'html' | 'csv' | 'json'
      rowIds?: string[]
    }): Promise<CallToolResult> => {
      try {
        return jsonResult(await exportInvestigationReport({ viewUUID, title, format, rowIds }))
      } catch (error) {
        return createErrorResponse(error)
      }
    }
  )
}
