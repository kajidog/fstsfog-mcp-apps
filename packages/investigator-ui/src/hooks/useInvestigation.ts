import type { InvestigationResult } from '@kajidog/investigation-shared'
import type { App } from '@modelcontextprotocol/ext-apps'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { useCallback, useRef, useState } from 'react'
import { extractViewUUID, fetchViewState, getResultText, runInvestigation } from './toolClient'

export type Phase = 'connecting' | 'waiting' | 'loading' | 'ready' | 'expired' | 'error'

export interface DraftParams {
  query: string
  from: string
  to: string
  groupBy?: string
  /** Fetch Datadog events for the window; inherited from the session when omitted */
  includeEvents?: boolean
  /** Events search query; inherited from the session when omitted */
  eventsQuery?: string
  /** Metric queries to fetch alongside logs. Inherited when omitted; [] clears them. */
  metricsQueries?: string[]
}

export function useInvestigation() {
  const [phase, setPhase] = useState<Phase>('connecting')
  const [result, setResult] = useState<InvestigationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const appRef = useRef<App | null>(null)
  const viewUUIDRef = useRef<string | null>(null)

  /** Called from ontoolresult: pull the investigation state for the viewUUID. */
  const attach = useCallback(async (app: App, toolResult: CallToolResult) => {
    appRef.current = app
    if (toolResult.isError) {
      setPhase('error')
      setError(getResultText(toolResult) || 'Tool call failed')
      return
    }
    const viewUUID = extractViewUUID(toolResult)
    if (!viewUUID) {
      setPhase('error')
      setError('Could not read viewUUID from the tool result (server/UI version mismatch?)')
      return
    }
    viewUUIDRef.current = viewUUID
    setPhase('loading')
    try {
      const state = await fetchViewState(app, viewUUID)
      if (!state) {
        setPhase('expired')
        return
      }
      setResult(state)
      setError(null)
      setPhase('ready')
    } catch (err) {
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  /** Re-run with adjusted params (UI-side edits). Keeps the last result on failure. */
  const run = useCallback(async (params: DraftParams) => {
    const app = appRef.current
    const viewUUID = viewUUIDRef.current
    if (!app || !viewUUID) {
      return
    }
    setRunning(true)
    setError(null)
    try {
      const next = await runInvestigation(app, { viewUUID, ...params })
      setResult(next)
      setPhase('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }, [])

  /** Fetch the next page of rows and append (server merges into the session). */
  const loadMore = useCallback(async () => {
    const app = appRef.current
    const viewUUID = viewUUIDRef.current
    const current = result
    if (!app || !viewUUID || !current?.nextCursor) {
      return
    }
    setLoadingMore(true)
    try {
      const next = await runInvestigation(app, {
        viewUUID,
        query: current.params.query,
        from: current.params.from,
        to: current.params.to,
        groupBy: current.params.groupBy,
        // Cross-source settings are part of the window too: without them a
        // load-more would re-run under whatever the session last inherited.
        includeEvents: current.params.includeEvents,
        eventsQuery: current.params.eventsQuery,
        metricsQueries: current.params.metricsQueries,
        cursor: current.nextCursor,
      })
      setResult(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingMore(false)
    }
  }, [result])

  return {
    phase,
    setPhase,
    result,
    error,
    setError,
    running,
    loadingMore,
    appRef,
    viewUUIDRef,
    attach,
    run,
    loadMore,
  }
}
