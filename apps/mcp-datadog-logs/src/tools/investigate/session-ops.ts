import { randomUUID } from 'node:crypto'
import type { InvestigationParams, InvestigationResult } from '@kajidog/investigation-shared'
import { extractLogPatterns } from '../../analysis/patterns.js'
import { getDatadogClient } from '../../datadog/client.js'
import { extractTraceCandidates, runInvestigation } from '../../datadog/investigation.js'
import { getSession, type InvestigationSession, setSession } from './runtime.js'

export interface StoreRunOptions {
  /** Update this session when present and found; otherwise create/recreate one under this ID */
  viewUUID?: string
  params: Partial<InvestigationParams>
  /** Replaces stored findings when provided; existing findings are preserved otherwise */
  findings?: string
}

export interface StoredRun {
  viewUUID: string
  session: InvestigationSession
}

/**
 * Run the investigation pipeline and persist the result in the session store.
 * With a cursor + existing session this is a load-more: the new page of rows
 * is merged (deduped by row id) into the stored session so exports and the UI
 * include everything loaded so far.
 */
export async function runAndStoreInvestigation(opts: StoreRunOptions): Promise<StoredRun> {
  const client = getDatadogClient()
  const existing = opts.viewUUID ? getSession(opts.viewUUID) : undefined
  const loadMoreParams = opts.params.cursor && existing ? existing.result.params : undefined
  const loadMoreRange = opts.params.cursor && existing ? existing.result.resolvedRange : undefined
  const title = opts.params.title ?? existing?.title
  const params: InvestigationParams = {
    query: opts.params.query ?? loadMoreParams?.query ?? '*',
    // Freeze relative ranges (for example now-1h -> now) to the exact window
    // resolved by the first request. Reusing the relative strings here would
    // shift the search and aggregate window every time another page is loaded.
    from: opts.params.from ?? (loadMoreRange ? new Date(loadMoreRange.fromMs).toISOString() : 'now-1h'),
    to: opts.params.to ?? (loadMoreRange ? new Date(loadMoreRange.toMs).toISOString() : 'now'),
    groupBy: opts.params.groupBy ?? loadMoreParams?.groupBy,
    limit: opts.params.limit ?? loadMoreParams?.limit,
    cursor: opts.params.cursor,
    title,
    // Cross-source settings are inherited from the stored session on any
    // update (not just load-more) so UI re-runs keep the configured metrics.
    includeEvents: opts.params.includeEvents ?? existing?.result.params.includeEvents,
    eventsQuery: opts.params.eventsQuery ?? existing?.result.params.eventsQuery,
    metricsQueries: opts.params.metricsQueries ?? existing?.result.params.metricsQueries,
    baseline: opts.params.baseline ?? existing?.result.params.baseline,
    baselineFrom: opts.params.baselineFrom ?? existing?.result.params.baselineFrom,
    baselineTo: opts.params.baselineTo ?? existing?.result.params.baselineTo,
  }
  const { result, rawById } = await runInvestigation(client, params)

  if (opts.params.cursor && existing) {
    const seen = new Set(existing.result.rows.map((r) => r.id))
    result.rows = [...existing.result.rows, ...result.rows.filter((r) => !seen.has(r.id))]
    for (const [id, raw] of existing.rawById) {
      if (!rawById.has(id)) {
        rawById.set(id, raw)
      }
    }
    // Load-more skips the events/metrics/comparison fetches (frozen window,
    // unchanged data) — carry the previous page's results forward instead.
    if (existing.result.events && !result.events) {
      result.events = existing.result.events
    }
    if (existing.result.metrics && !result.metrics) {
      result.metrics = existing.result.metrics
    }
    if (existing.result.comparison && !result.comparison) {
      result.comparison = existing.result.comparison
    }
    if (existing.result.notices && !result.notices) {
      result.notices = existing.result.notices
    }
  }
  // After the load-more merge so patterns and trace candidates always
  // reflect every stored row.
  result.patterns = extractLogPatterns(result.rows)
  const traceCandidates = extractTraceCandidates(result.rows)
  if (traceCandidates.length > 0) {
    result.traceCandidates = traceCandidates
  } else {
    delete result.traceCandidates
  }

  // Reuse a passed-but-evicted viewUUID so callers keep a stable handle; the
  // session is simply recreated (previous rows/findings are gone).
  const viewUUID = opts.viewUUID ?? randomUUID()
  const now = Date.now()
  const session: InvestigationSession = {
    result,
    rawById,
    title,
    findings: opts.findings ?? existing?.findings,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  setSession(viewUUID, session)
  return { viewUUID, session }
}

/** InvestigationResult with session.findings stitched in — the wire payload for the UI. */
export function sessionResult(session: InvestigationSession): InvestigationResult {
  return session.findings ? { ...session.result, findings: session.findings } : session.result
}
