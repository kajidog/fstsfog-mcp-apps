import type { LogRow, TraceCandidate } from '@kajidog/investigation-shared'
import { Check, ChevronDown, ChevronRight, CircleAlert, Copy, Loader2, Waypoints } from 'lucide-react'
import { Fragment, type MouseEvent, type ReactNode, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { TraceView } from '@/hooks/toolClient'
import { highlightText } from '@/lib/highlight'
import { cn } from '@/lib/utils'

const STATUS_BADGE_CLASS: Record<string, string> = {
  error: 'bg-status-error text-white',
  warn: 'bg-status-warn text-black',
  info: 'bg-status-info text-white',
  debug: 'bg-status-debug text-white',
}

const JSON_TOKEN_PATTERN =
  /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b)/g

const TRACE_UNAVAILABLE = 'このトレースは取得できませんでした。調査セッションが期限切れの可能性があります。'

/** Loaded trace tree, or the reason it could not be rendered (missing apm_read scope, expired session, …). */
type TraceState = { status: 'ready'; tree: string } | { status: 'error'; message: string }

interface LogTableProps {
  rows: LogRow[]
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  fetchDetail: (logId: string) => Promise<unknown | null>
  /** Fetch the rendered APM trace for a trace id; null when the session or id is unknown */
  fetchTrace?: (traceId: string) => Promise<TraceView | null>
  /** Trace ids seen across the fetched rows, shown as a pivot strip above the table */
  traceCandidates?: TraceCandidate[]
  /** Message shown when rows is empty (e.g. differs when a local filter is active) */
  emptyMessage?: string
  /** Keyword-filter terms to emphasize inside the message column */
  highlightTerms?: string[]
}

export function LogTable({
  rows,
  hasMore,
  loadingMore,
  onLoadMore,
  fetchDetail,
  fetchTrace,
  traceCandidates,
  emptyMessage,
  highlightTerms,
}: LogTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, unknown>>({})
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // Keyed by call site (a row id, or the candidate strip) so the same trace id
  // opened from two rows does not render the panel under both.
  const [expandedTrace, setExpandedTrace] = useState<{ key: string; traceId: string } | null>(null)
  const [traces, setTraces] = useState<Record<string, TraceState>>({})
  const [loadingTraceId, setLoadingTraceId] = useState<string | null>(null)
  const [copiedTraceId, setCopiedTraceId] = useState<string | null>(null)

  const toggle = async (row: LogRow) => {
    if (expandedId === row.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(row.id)
    if (!(row.id in details)) {
      setLoadingId(row.id)
      try {
        const detail = await fetchDetail(row.id)
        setDetails((prev) => ({ ...prev, [row.id]: detail ?? row }))
      } catch {
        setDetails((prev) => ({ ...prev, [row.id]: row }))
      } finally {
        setLoadingId(null)
      }
    }
  }

  const toggleTrace = async (key: string, traceId: string) => {
    if (expandedTrace?.key === key) {
      setExpandedTrace(null)
      return
    }
    setExpandedTrace({ key, traceId })
    if (traceId in traces) {
      return
    }
    setLoadingTraceId(traceId)
    try {
      const trace = fetchTrace ? await fetchTrace(traceId) : null
      setTraces((prev) => ({
        ...prev,
        [traceId]: trace ? { status: 'ready', tree: trace.tree } : { status: 'error', message: TRACE_UNAVAILABLE },
      }))
    } catch (err) {
      setTraces((prev) => ({
        ...prev,
        [traceId]: { status: 'error', message: err instanceof Error ? err.message : String(err) },
      }))
    } finally {
      setLoadingTraceId(null)
    }
  }

  const copyDetail = async (event: MouseEvent<HTMLButtonElement>, rowId: string, json: string) => {
    event.stopPropagation()
    const copied = await copyText(json)
    if (!copied) {
      return
    }
    setCopiedId(rowId)
    window.setTimeout(() => {
      setCopiedId((current) => (current === rowId ? null : current))
    }, 1500)
  }

  const copyTraceId = async (event: MouseEvent<HTMLButtonElement>, traceId: string) => {
    event.stopPropagation()
    const copied = await copyText(traceId)
    if (!copied) {
      return
    }
    setCopiedTraceId(traceId)
    window.setTimeout(() => {
      setCopiedTraceId((current) => (current === traceId ? null : current))
    }, 1500)
  }

  const renderTracePanel = (traceId: string) => (
    <div className="bg-muted/40">
      <div className="flex items-center gap-1.5 border-b px-3 py-1">
        <Waypoints className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate font-mono text-[11px] text-muted-foreground">trace:{traceId}</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="trace_id をコピー"
          title={copiedTraceId === traceId ? 'コピーしました' : 'trace_id をコピー'}
          onClick={(event) => void copyTraceId(event, traceId)}
        >
          {copiedTraceId === traceId ? <Check className="text-status-info" /> : <Copy />}
        </Button>
      </div>
      {loadingTraceId === traceId ? (
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> トレースを読み込み中…
        </div>
      ) : traces[traceId]?.status === 'error' ? (
        <div className="flex items-start gap-2 p-3 text-xs text-muted-foreground">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-status-warn" aria-hidden />
          <span className="whitespace-pre-wrap">トレースを表示できません: {traces[traceId].message}</span>
        </div>
      ) : (
        <pre className="max-h-72 overflow-auto p-3 text-[11px] leading-relaxed">
          {traces[traceId]?.status === 'ready' ? traces[traceId].tree : ''}
        </pre>
      )}
    </div>
  )

  const candidates = traceCandidates ?? []
  const traceStrip =
    candidates.length > 0 ? (
      <div className="border-b px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Waypoints className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">トレース候補:</span>
          {candidates.map((candidate) => {
            const key = `candidate:${candidate.traceId}`
            return (
              <button
                key={candidate.traceId}
                type="button"
                onClick={() => void toggleTrace(key, candidate.traceId)}
                title={candidate.sampleMessage ?? `trace:${candidate.traceId}`}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border py-0.5 pl-2.5 pr-2 hover:bg-accent',
                  expandedTrace?.key === key ? 'bg-accent' : 'bg-muted/40'
                )}
              >
                <span className="max-w-32 truncate font-mono">{candidate.traceId}</span>
                <span className="text-muted-foreground">
                  {candidate.count} 件{candidate.errorCount > 0 ? ` / ${candidate.errorCount} error` : ''}
                </span>
              </button>
            )
          })}
        </div>
        {expandedTrace?.key.startsWith('candidate:') && (
          <div className="mt-1.5 overflow-hidden rounded-md border">{renderTracePanel(expandedTrace.traceId)}</div>
        )}
      </div>
    ) : null

  if (rows.length === 0) {
    return (
      <div>
        {traceStrip}
        <p className="py-6 text-center text-sm text-muted-foreground">
          {emptyMessage ?? 'この範囲にログはありません。'}
        </p>
      </div>
    )
  }

  return (
    <div>
      {traceStrip}
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead className="w-32 md:w-40">時刻</TableHead>
            <TableHead className="w-24">ステータス</TableHead>
            <TableHead className="w-32 max-md:hidden">サービス</TableHead>
            <TableHead>メッセージ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const detailJson = JSON.stringify(details[row.id] ?? row, null, 2)
            const copied = copiedId === row.id
            const traceOpen = expandedTrace?.key === row.id

            return (
              <Fragment key={row.id}>
                <TableRow className="cursor-pointer" onClick={() => toggle(row)}>
                  <TableCell className="py-1.5 text-muted-foreground">
                    {expandedId === row.id ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-1.5 text-xs text-muted-foreground" title={row.timestamp}>
                    {formatTimestamp(row.timestamp)}
                  </TableCell>
                  <TableCell className="py-1.5">
                    <Badge
                      className={cn(
                        'px-1.5 py-0 text-[10px]',
                        STATUS_BADGE_CLASS[row.status] ?? STATUS_BADGE_CLASS.debug
                      )}
                    >
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className="truncate py-1.5 text-xs text-muted-foreground max-md:hidden"
                    title={row.service}
                  >
                    {row.service ?? '-'}
                  </TableCell>
                  <TableCell className="truncate py-1.5 text-xs" title={row.message}>
                    {row.traceId && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          void toggleTrace(row.id, row.traceId ?? '')
                        }}
                        title={`トレースを表示: ${row.traceId}`}
                        className={cn(
                          'mr-1.5 inline-flex max-w-32 items-center gap-1 truncate rounded px-1 font-mono text-[10px] text-muted-foreground hover:bg-accent',
                          traceOpen ? 'bg-accent' : 'bg-muted'
                        )}
                      >
                        <Waypoints className="size-2.5 shrink-0" aria-hidden />
                        <span className="truncate">trace:{row.traceId}</span>
                      </button>
                    )}
                    {row.message ? highlightText(row.message, highlightTerms ?? []) : '(メッセージなし)'}
                  </TableCell>
                </TableRow>
                {expandedId === row.id && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="bg-muted/40 p-0">
                      {loadingId === row.id ? (
                        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" /> 詳細を読み込み中…
                        </div>
                      ) : (
                        <div className="relative">
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            className="absolute right-2 top-2 z-10 bg-background/85 shadow-xs backdrop-blur hover:bg-background"
                            aria-label="展開したログJSONをコピー"
                            title={copied ? 'コピーしました' : 'JSONをコピー'}
                            onClick={(event) => void copyDetail(event, row.id, detailJson)}
                          >
                            {copied ? <Check className="text-status-info" /> : <Copy />}
                          </Button>
                          <pre className="max-h-72 overflow-auto p-3 pr-12 text-[11px] leading-relaxed">
                            <code>{renderHighlightedJson(detailJson)}</code>
                          </pre>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )}
                {traceOpen && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="p-0">
                      {renderTracePanel(expandedTrace.traceId)}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
      {hasMore && (
        <div className="flex justify-center py-2">
          <Button size="sm" variant="ghost" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="animate-spin" />}
            さらに読み込む
          </Button>
        </div>
      )}
    </div>
  )
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the textarea copy path for hosts without clipboard permission.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '0'
  textarea.style.top = '0'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
}

function renderHighlightedJson(json: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  JSON_TOKEN_PATTERN.lastIndex = 0

  for (let match = JSON_TOKEN_PATTERN.exec(json); match; match = JSON_TOKEN_PATTERN.exec(json)) {
    const token = match[0]
    const index = match.index
    if (index > lastIndex) {
      nodes.push(json.slice(lastIndex, index))
    }
    nodes.push(
      <span key={index} className={jsonTokenClass(token, json.slice(index + token.length))}>
        {token}
      </span>
    )
    lastIndex = index + token.length
  }

  if (lastIndex < json.length) {
    nodes.push(json.slice(lastIndex))
  }
  return nodes
}

function jsonTokenClass(token: string, afterToken: string): string {
  if (token.startsWith('"')) {
    return /^\s*:/.test(afterToken) ? 'text-status-info' : 'text-emerald-700 dark:text-emerald-300'
  }
  if (token === 'true' || token === 'false') {
    return 'text-fuchsia-700 dark:text-fuchsia-300'
  }
  if (token === 'null') {
    return 'text-muted-foreground'
  }
  return 'text-amber-700 dark:text-amber-300'
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${mo}/${dd} ${hh}:${mm}:${ss}`
}
