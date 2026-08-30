import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import { HARD_MAX_ROWS } from '../config.js'
import { getDatadogClient } from '../datadog/client.js'
import { runComparison } from '../datadog/comparison.js'
import { formatComparisonSummary } from './comparison-summary.js'
import { getSession, setSession } from './investigate/runtime.js'
import { registerPrefixedTool } from './registration.js'
import { createErrorResponse, stringListParam, textResult, toStringList } from './utils.js'

const DEFAULT_FACETS = ['service']
const MAX_FACETS = 3

interface CompareWindowsArgs {
  query: string
  from: string
  to: string
  baseline?: string
  baselineFrom?: string
  baselineTo?: string
  scope: string
  facets?: string[] | string
  sample_limit: number
  include_events: boolean
  include_patterns: boolean
  viewUUID?: string
}

export function registerCompareWindowsTool(server: McpServer): void {
  registerPrefixedTool(
    server,
    'compare_windows',
    {
      title: 'Compare a Log Window Against a Baseline',
      description:
        'Answer "is this window actually abnormal, and compared to what?" by measuring a target time window ' +
        'against a baseline window (the preceding window by default, or the same window a day/week earlier). ' +
        'Returns volume and error-rate deltas, the message templates that appeared or spiked, which facet values ' +
        'the change is concentrated in, and when the error rate started departing — with the deploy/alert events ' +
        'around that moment. Use it once you have a suspicious window (from datadog_search_logs, a monitor, or an ' +
        'investigation), not to browse: one call issues up to 13 Datadog requests (9 with the defaults), so it is ' +
        'far too expensive to run in a loop. Narrow the query first and compare once. Pass a viewUUID to attach ' +
        'the comparison to an existing investigation session.',
      inputSchema: {
        query: z.string().default('*').describe('Datadog logs query both windows are measured with'),
        from: z
          .string()
          .default('now-1h')
          .describe('Target window start: Datadog time math ("now-1h") or ISO 8601 with a time zone'),
        to: z.string().default('now').describe('Target window end: Datadog time math ("now") or ISO 8601'),
        baseline: z
          .string()
          .optional()
          .describe(
            'How to derive the baseline window: "previous" (default, the window immediately before the target) ' +
              'or a shift back by that much ("1d", "1w", "4h"). "now-1d" is accepted and means the same as "1d" — ' +
              'the target window moved back, not a window starting at that instant. The baseline always has the ' +
              "target's duration; use baselineFrom/baselineTo for an arbitrary window."
          ),
        baselineFrom: z
          .string()
          .optional()
          .describe('Explicit baseline start; overrides "baseline". Honoured on its own (baselineTo then defaults)'),
        baselineTo: z.string().optional().describe('Explicit baseline end; honoured on its own'),
        scope: z
          .string()
          .default('status:error')
          .describe('Extra filter for the pattern samples only, e.g. "status:error"; "" compares all statuses'),
        facets: stringListParam(MAX_FACETS)
          .optional()
          .describe('Facets to attribute the change to, max 3 (default: ["service"]), e.g. ["service", "host"]'),
        sample_limit: z
          .number()
          .int()
          .min(20)
          .max(HARD_MAX_ROWS)
          .default(200)
          .describe('Rows sampled per window for the message-template diff'),
        include_events: z
          .boolean()
          .default(true)
          .describe('Fetch Datadog events (deploys, alerts) to annotate the onset (needs events_read)'),
        include_patterns: z
          .boolean()
          .default(true)
          .describe('Sample rows in both windows and diff their message templates; false saves 2 requests'),
        viewUUID: z
          .uuid()
          .optional()
          .describe('Attach the comparison to this existing investigation session so the UI and report can show it'),
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
      baseline,
      baselineFrom,
      baselineTo,
      scope,
      facets,
      sample_limit,
      include_events,
      include_patterns,
      viewUUID,
    }: CompareWindowsArgs): Promise<CallToolResult> => {
      try {
        const client = getDatadogClient()
        const result = await runComparison(client, {
          query,
          from,
          to,
          ...(baseline !== undefined ? { baseline } : {}),
          ...(baselineFrom !== undefined ? { baselineFrom } : {}),
          ...(baselineTo !== undefined ? { baselineTo } : {}),
          scope,
          facets: toStringList(facets, MAX_FACETS) ?? DEFAULT_FACETS,
          sampleLimit: sample_limit,
          includeEvents: include_events,
          includePatterns: include_patterns,
        })
        const summary = formatComparisonSummary(result)
        if (!viewUUID) {
          return textResult(summary)
        }

        const session = getSession(viewUUID)
        if (!session) {
          // No viewUUID line here: claiming a session the UI cannot open would be a lie.
          return textResult(
            `${summary}\nNote: investigation session ${viewUUID} was not found, so this comparison was ` +
              'not attached to it. Run datadog_run_investigation to create a session first.'
          )
        }
        session.result = { ...session.result, comparison: result }
        session.updatedAt = Date.now()
        setSession(viewUUID, session)
        // The viewUUID contract line must stay on line one (VIEW_UUID_PATTERN).
        return textResult(
          `viewUUID: ${viewUUID}\n${summary}\n` +
            'Comparison attached to the session; call datadog_investigate_logs with this viewUUID to show it.'
        )
      } catch (error) {
        return createErrorResponse(error, 'logs_read_data')
      }
    }
  )
}
