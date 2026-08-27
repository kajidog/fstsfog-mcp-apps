import type { ExportResult, InvestigationResult } from '@kajidog/investigation-shared'
import type { App } from '@modelcontextprotocol/ext-apps'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

// The host forwards only content text (not structuredContent/_meta) to the
// app, so all data flows through JSON text + the viewUUID regex contract.
// Contract source: apps/mcp-datadog-logs/src/tools/investigate/investigate-tool.ts

export function getResultText(result: CallToolResult): string {
  const textContent = result.content?.find((c: { type: string }) => c.type === 'text')
  return textContent?.type === 'text' ? textContent.text : ''
}

export function extractViewUUID(result: CallToolResult): string | null {
  const match = getResultText(result).match(/viewUUID:\s*([0-9a-fA-F-]{36})/)
  return match ? match[1] : null
}

function parseJsonResult<T>(result: CallToolResult, context: string): T {
  const text = getResultText(result)
  if (result.isError) {
    throw new Error(text || `${context} failed`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${context}: unexpected response: ${text.slice(0, 200)}`)
  }
}

export interface RunInvestigationArgs {
  viewUUID: string
  query: string
  from: string
  to: string
  groupBy?: string
  limit?: number
  cursor?: string
  /** Fetch Datadog events for the window; inherited from the session when omitted */
  includeEvents?: boolean
  /** Events search query; inherited from the session when omitted */
  eventsQuery?: string
  /** Metric queries to fetch alongside logs. Inherited when omitted; [] clears them. */
  metricsQueries?: string[]
}

export async function fetchViewState(app: App, viewUUID: string): Promise<InvestigationResult | null> {
  const result = await app.callServerTool({ name: '_get_view_state', arguments: { viewUUID } })
  const parsed = parseJsonResult<InvestigationResult | { notFound: true }>(result, '_get_view_state')
  return 'notFound' in parsed ? null : parsed
}

export async function runInvestigation(app: App, args: RunInvestigationArgs): Promise<InvestigationResult> {
  const result = await app.callServerTool({ name: '_run_investigation', arguments: { ...args } })
  return parseJsonResult<InvestigationResult>(result, '_run_investigation')
}

export async function fetchLogDetail(app: App, viewUUID: string, logId: string): Promise<unknown | null> {
  const result = await app.callServerTool({ name: '_get_log_detail', arguments: { viewUUID, logId } })
  const parsed = parseJsonResult<Record<string, unknown>>(result, '_get_log_detail')
  return parsed && typeof parsed === 'object' && 'notFound' in parsed ? null : parsed
}

/** Rendered APM trace for one trace id, as `datadog_get_trace` would print it. */
export interface TraceView {
  traceId: string
  tree: string
}

export interface FetchTraceArgs {
  errorsOnly?: boolean
  maxSpans?: number
}

/**
 * The server derives the time bracket from the session and rejects trace ids
 * that are not on a stored row, so only the viewUUID + id travel from here.
 */
export async function fetchTrace(
  app: App,
  viewUUID: string,
  traceId: string,
  args: FetchTraceArgs = {}
): Promise<TraceView | null> {
  const result = await app.callServerTool({
    name: '_get_trace',
    arguments: {
      viewUUID,
      traceId,
      ...(args.errorsOnly !== undefined ? { errorsOnly: args.errorsOnly } : {}),
      ...(args.maxSpans !== undefined ? { maxSpans: args.maxSpans } : {}),
    },
  })
  const parsed = parseJsonResult<TraceView | { notFound: true }>(result, '_get_trace')
  return 'notFound' in parsed ? null : parsed
}

export interface ExportReportArgs {
  title?: string
  format?: 'html' | 'csv' | 'json'
  /** csv/json only: export just these stored rows (e.g. the filtered view) */
  rowIds?: string[]
}

export async function exportReport(app: App, viewUUID: string, args: ExportReportArgs = {}): Promise<ExportResult> {
  const { title, format, rowIds } = args
  const result = await app.callServerTool({
    name: '_export_report',
    arguments: {
      viewUUID,
      ...(title ? { title } : {}),
      ...(format ? { format } : {}),
      ...(rowIds ? { rowIds } : {}),
    },
  })
  return parseJsonResult<ExportResult>(result, '_export_report')
}
