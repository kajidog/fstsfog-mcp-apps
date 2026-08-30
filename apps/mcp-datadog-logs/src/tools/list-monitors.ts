import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import { getDatadogClient } from '../datadog/client.js'
import type { RawMonitor } from '../datadog/normalize.js'
import { registerPrefixedTool } from './registration.js'
import { createErrorResponse, stringListParam, textResult, toStringList } from './utils.js'

const MAX_NAME_LENGTH = 120
const MAX_QUERY_LENGTH = 200
const MAX_TAGS = 8
const MAX_TAG_LENGTH = 60

const DEFAULT_STATES = ['alert', 'warn', 'no data']

/**
 * last_triggered has no API sort key, so the newest monitors can only surface
 * by over-fetching one page and ordering it here. Bounded to a single page so
 * a small org cannot be pushed into 429s.
 */
const LAST_TRIGGERED_FETCH_PAGE = 100

/** How an empty query (= every monitor) is shown to the model; the wire value stays ''. */
const ALL_MONITORS_QUERY = '*'

/** Monitor overall states keyed by a separator-insensitive alias. 'all' means "no status clause". */
const STATE_ALIASES: Record<string, string> = {
  alert: 'Alert',
  alerting: 'Alert',
  triggered: 'Alert',
  critical: 'Alert',
  warn: 'Warn',
  warning: 'Warn',
  nodata: 'No Data',
  ok: 'OK',
  recovered: 'OK',
  ignored: 'Ignored',
  skipped: 'Skipped',
  unknown: 'Unknown',
}

export interface MonitorSearchQueryParts {
  /** Monitor states; defaults to alert/warn/no data. "all" anywhere in the list drops the status clause. */
  state?: string[]
  tags?: string[]
  name?: string
}

function stateKey(state: string): string {
  return state.toLowerCase().replace(/[\s_-]+/g, '')
}

function normalizeState(state: string): string {
  return STATE_ALIASES[stateKey(state)] ?? state.trim()
}

/** Quotes a status value only when it needs it, e.g. status:"No Data". */
function statusClause(status: string): string {
  return /\s/.test(status) ? `status:"${status}"` : `status:${status}`
}

/**
 * Builds a Datadog monitor search query from the structured params.
 * States OR together; tags AND together and are always quoted because monitor
 * tags themselves contain ':'. `name` is appended bare — monitor search
 * substring-matches free text against the monitor name.
 */
export function buildMonitorSearchQuery(parts: MonitorSearchQueryParts): string {
  const states = parts.state && parts.state.length > 0 ? parts.state : DEFAULT_STATES
  // "all" anywhere widens to every state: someone passing ["all","alert"] wants
  // everything, not a list silently narrowed back down to alerting monitors.
  const includesAll = states.some((state) => stateKey(state) === 'all')
  const statuses = includesAll ? [] : [...new Set(states.map(normalizeState).filter(Boolean))]
  const clauses: string[] = []
  if (statuses.length === 1) {
    clauses.push(statusClause(statuses[0]))
  } else if (statuses.length > 1) {
    clauses.push(`(${statuses.map(statusClause).join(' OR ')})`)
  }
  for (const tag of parts.tags ?? []) {
    clauses.push(`tag:"${tag.replace(/"/g, '\\"')}"`)
  }
  const name = parts.name?.trim()
  if (name) {
    clauses.push(name)
  }
  return clauses.join(' ')
}

/** Coarse age for a monitor's last trigger: "14m ago" / "3h ago" / "2d ago". */
export function formatRelativeAge(ms: number): string {
  const clamped = Math.max(0, ms)
  const minutes = Math.floor(clamped / 60_000)
  if (minutes < 1) {
    return '<1m ago'
  }
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  return `${Math.floor(hours / 24)}d ago`
}

/** Datadog reports lastTriggeredTs in epoch seconds; ms precision is always zero, so trim it. */
function toSecondIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

/**
 * Last trigger time in epoch seconds, or undefined when the monitor never
 * triggered. Despite the `number` typing, the SDK deserializer passes a JSON
 * `null` straight through (`data == undefined` is a loose check that only
 * short-circuits on the value it is comparing against), and 0 is not a real
 * trigger time either — both must read as "never" rather than as 1970.
 */
function triggeredSeconds(monitor: RawMonitor): number | undefined {
  const ts = monitor.lastTriggeredTs
  return typeof ts !== 'number' || ts <= 0 ? undefined : ts
}

/**
 * One monitor as a status/trigger headline plus an indented query line, e.g.
 * `[Alert] payments error rate high (id 1) — triggered 14m ago (…) | tags: env:prod`
 */
export function formatMonitorLine(monitor: RawMonitor, nowMs: number = Date.now()): string {
  const name = truncate((monitor.name ?? '').replace(/\s+/g, ' ').trim() || '(no name)', MAX_NAME_LENGTH)
  const seconds = triggeredSeconds(monitor)
  const triggered =
    seconds === undefined
      ? 'never triggered'
      : `triggered ${formatRelativeAge(nowMs - seconds * 1000)} (${toSecondIso(seconds)})`
  const parts = [
    `[${monitor.status ?? 'Unknown'}]`,
    name,
    monitor.id === undefined ? undefined : `(id ${monitor.id})`,
    `— ${triggered}`,
  ]
  const tags = monitor.tags ?? []
  if (tags.length > 0) {
    const shown = tags.slice(0, MAX_TAGS).map((tag) => truncate(tag, MAX_TAG_LENGTH))
    const more = tags.length > MAX_TAGS ? ` (+${tags.length - MAX_TAGS} more)` : ''
    parts.push(`| tags: ${shown.join(', ')}${more}`)
  }
  const headline = parts.filter(Boolean).join(' ')
  const query = monitor.query?.replace(/\s+/g, ' ').trim()
  return query ? `${headline}\n  query: ${truncate(query, MAX_QUERY_LENGTH)}` : headline
}

/** Most recently triggered first; monitors that never triggered sort last. */
function byLastTriggeredDesc(a: RawMonitor, b: RawMonitor): number {
  return (triggeredSeconds(b) ?? -1) - (triggeredSeconds(a) ?? -1)
}

// The API only supports name/status/tags sort keys, so last_triggered is sorted client-side.
const API_SORT: Record<string, string | undefined> = {
  status: 'status,asc',
  name: 'name,asc',
  last_triggered: undefined,
}

export function registerListMonitorsTool(server: McpServer): void {
  registerPrefixedTool(
    server,
    'list_monitors',
    {
      title: 'List Datadog Monitors',
      description:
        'List Datadog monitors with their current state, last trigger time, and query as compact text. Use it to ' +
        'see what is alerting right now before digging into logs, or to find the monitor behind an alert event: ' +
        'e.g. default (alerting/warning/no-data monitors), tags ["service:payments"] for one service, or a raw ' +
        'Datadog monitor search query for anything else.',
      inputSchema: {
        state: stringListParam(5)
          .optional()
          .describe(
            'Monitor states to include, e.g. ["alert","warn"]. Accepts aliases (alerting/triggered/critical, ' +
              'warning, no_data, recovered). Use ["all"] for every state. Default: ["alert","warn","no data"]'
          ),
        tags: stringListParam(10)
          .optional()
          .describe('Monitor tags to require (AND), e.g. ["service:payments","env:prod"]'),
        name: z.string().optional().describe('Substring matched against the monitor name'),
        query: z
          .string()
          .optional()
          .describe(
            'Raw Datadog monitor search query, e.g. \'status:Alert type:metric tag:"env:prod"\'. ' +
              'When set, state/tags/name are ignored'
          ),
        limit: z.number().int().min(1).max(100).default(25).describe('Max monitors to return'),
        sort: z
          .enum(['status', 'name', 'last_triggered'])
          .default('status')
          .describe(
            'Result order: by state name (alphabetical, so Alert comes first — not by severity), by monitor ' +
              'name, or most recently triggered first'
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({
      state,
      tags,
      name,
      query,
      limit,
      sort,
    }: {
      state?: string[] | string
      tags?: string[] | string
      name?: string
      query?: string
      limit: number
      sort: 'status' | 'name' | 'last_triggered'
    }): Promise<CallToolResult> => {
      try {
        const rawQuery = query?.trim()
        const effectiveQuery =
          rawQuery ||
          buildMonitorSearchQuery({
            state: toStringList(state, 5),
            tags: toStringList(tags, 10),
            ...(name ? { name } : {}),
          })
        const displayQuery = effectiveQuery || ALL_MONITORS_QUERY
        const byLastTriggered = sort === 'last_triggered'
        const apiSort = API_SORT[sort]
        const client = getDatadogClient()
        // Sorting client-side only orders what the page already contains, so
        // over-fetch first — otherwise "most recently triggered" would rank an
        // arbitrary `limit`-sized slice of the matches.
        const { monitors, totalCount } = await client.searchMonitors({
          query: effectiveQuery,
          perPage: byLastTriggered ? Math.max(limit, LAST_TRIGGERED_FETCH_PAGE) : limit,
          ...(apiSort ? { sort: apiSort } : {}),
        })
        if (monitors.length === 0) {
          return textResult(`No monitors matched query "${displayQuery}".`)
        }
        const ordered = byLastTriggered ? [...monitors].sort(byLastTriggeredDesc).slice(0, limit) : monitors
        const total = totalCount === undefined ? '' : ` of ~${totalCount}`
        const header = `${ordered.length}${total} monitors (query: ${displayQuery})`
        const now = Date.now()
        // Beyond one fetched page the ordering is only best-effort; say so rather than implying a global ranking.
        const partialSort =
          byLastTriggered && totalCount !== undefined && totalCount > monitors.length
            ? `\n(sorted by last trigger within the first ${monitors.length} matches only; narrow with tags/name for an exact ranking)`
            : ''
        return textResult(
          `${header}\n${ordered.map((monitor) => formatMonitorLine(monitor, now)).join('\n')}${partialSort}`
        )
      } catch (error) {
        return createErrorResponse(error, 'monitors_read')
      }
    }
  )
}
