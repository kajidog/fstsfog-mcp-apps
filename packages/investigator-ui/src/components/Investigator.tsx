import type { TimelineBucket } from '@kajidog/investigation-shared'
import type { App } from '@modelcontextprotocol/ext-apps'
import { useApp } from '@modelcontextprotocol/ext-apps/react'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ChevronDown, CircleAlert, FileDown, ListFilter, Loader2, NotebookPen, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { createMockApp, MOCK_VIEW_UUID } from '@/hooks/devMockApp'
import { exportReport, fetchLogDetail } from '@/hooks/toolClient'
import { useDisplayMode } from '@/hooks/useDisplayMode'
import { useInvestigation } from '@/hooks/useInvestigation'
import { useMcpResizeNotifications } from '@/hooks/useMcpResizeNotifications'
import { cn } from '@/lib/utils'
import { ComparisonPanel } from './ComparisonPanel'
import { EventList } from './EventList'
import { FACET_META, FacetSidebar, facetKey } from './FacetSidebar'
import { LogTable } from './LogTable'
import { Markdown } from './Markdown'
import { MetricsPanel } from './MetricsPanel'
import { PatternList } from './PatternList'
import { QueryBar } from './QueryBar'
import { TimelineChart } from './TimelineChart'

const isStandaloneDev = import.meta.env.DEV && window.self === window.top

export function Investigator() {
  const investigation = useInvestigation()
  const { phase, setPhase, result, error, setError, running, loadingMore, appRef, viewUUIDRef, attach, run, loadMore } =
    investigation

  // Draft params edited in the UI; synced from the server result on load.
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('now-1h')
  const [to, setTo] = useState('now')
  const syncedRef = useRef(false)

  const [exporting, setExporting] = useState(false)
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [exportOpenError, setExportOpenError] = useState<string | null>(null)

  // Client-side narrowing of already-fetched rows — no API call involved.
  const [localKeyword, setLocalKeyword] = useState('')
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)
  const [selectedPattern, setSelectedPattern] = useState<string | null>(null)
  const [exportingData, setExportingData] = useState<'csv' | 'json' | null>(null)

  const { app: connectedApp } = useApp({
    appInfo: { name: 'Datadog Logs Investigator', version: '1.0.0' },
    capabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    autoResize: false,
    onAppCreated: (createdApp: App) => {
      if (isStandaloneDev) {
        return
      }
      appRef.current = createdApp
      createdApp.ontoolinput = async () => {
        setPhase('waiting')
      }
      createdApp.ontoolresult = async (toolResult: CallToolResult) => {
        await attach(createdApp, toolResult)
      }
      createdApp.ontoolcancelled = () => {
        setPhase('error')
        setError('ツール呼び出しがキャンセルされました。アシスタントに調査の再実行を依頼してください。')
      }
      createdApp.onteardown = async () => ({})
      createdApp.onerror = (err: unknown) => {
        setPhase('error')
        setError(String(err))
      }
    },
  })
  // Rows narrowed client-side by the selected timeline bucket and local keyword.
  // A bucket stays selected only while it exists in the current timeline, so a
  // re-run with a different range implicitly clears it.
  const effectiveBucket =
    selectedBucket && result?.timeline.some((b) => b.time === selectedBucket) ? selectedBucket : null
  const bucketRange =
    result && effectiveBucket
      ? resolveBucketRange(result.timeline, effectiveBucket, result.interval, result.resolvedRange.toMs)
      : null
  const keywordTerms = localKeyword.trim().toLowerCase().split(/\s+/).filter(Boolean)
  // A pattern stays selected only while it exists in the current result, so a
  // re-run that changes the clustering implicitly clears it.
  const activePattern =
    selectedPattern !== null ? (result?.patterns ?? []).find((p) => p.template === selectedPattern) : undefined
  const patternRowIds = activePattern ? new Set(activePattern.rowIds) : null
  const localFilterActive = Boolean(bucketRange) || keywordTerms.length > 0 || Boolean(patternRowIds)
  const filteredRows = (result?.rows ?? []).filter((row) => {
    if (patternRowIds && !patternRowIds.has(row.id)) {
      return false
    }
    if (bucketRange) {
      const t = Date.parse(row.timestamp)
      if (Number.isNaN(t) || t < bucketRange.startMs || t >= bucketRange.endMs) {
        return false
      }
    }
    if (keywordTerms.length > 0) {
      const haystack = [row.message, row.service, row.host, row.status, ...(row.tags ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (!keywordTerms.every((term) => haystack.includes(term))) {
        return false
      }
    }
    return true
  })

  const displayMode = useDisplayMode(isStandaloneDev ? null : connectedApp)
  const fullscreen = displayMode.displayMode === 'fullscreen'
  const resizeTrigger = [
    phase,
    fullscreen ? 'fullscreen' : 'inline',
    running ? 'running' : 'idle',
    loadingMore ? 'loadingMore' : 'idle',
    result?.fetchedAt ?? '',
    result?.rows.length ?? 0,
    filteredRows.length,
    effectiveBucket ?? '',
    result?.nextCursor ?? '',
    error ?? '',
    exportPath ?? '',
    result?.findings?.length ?? 0,
    activePattern?.template ?? '',
    result?.patterns?.length ?? 0,
    result?.events?.length ?? 0,
    result?.metrics?.length ?? 0,
    result?.notices?.length ?? 0,
    result?.comparison?.fetchedAt ?? '',
  ].join(':')
  useMcpResizeNotifications(isStandaloneDev ? null : connectedApp, resizeTrigger)

  // DEV standalone mode: render with a mock bridge + fixture data.
  useEffect(() => {
    if (!isStandaloneDev) {
      return
    }
    const mock = createMockApp()
    void attach(mock, { content: [{ type: 'text', text: `mock. viewUUID: ${MOCK_VIEW_UUID}` }] })
  }, [attach])

  // Sync draft inputs from the first loaded result.
  useEffect(() => {
    if (result && !syncedRef.current) {
      syncedRef.current = true
      setQuery(result.params.query)
      setFrom(result.params.from)
      setTo(result.params.to)
    }
  }, [result])

  const handleRun = (nextQuery = query) => {
    setExportPath(null)
    setExportOpenError(null)
    void run({ query: nextQuery, from, to, groupBy: result?.params.groupBy })
  }

  // facet:value tokens currently present in the query, shown as removable chips.
  const activeFilters = parseFacetTokens(query)
  const activeKeys = new Set(activeFilters.map((t) => facetKey(t.facet, t.value)))

  const handleFacetSelect = (facet: string, value: string) => {
    const existing = activeFilters.find((t) => t.facet === facet && t.value === value)
    const nextQuery = existing
      ? removeRange(query, existing.start, existing.end)
      : `${query.trim()} ${facet}:${quoteValue(value)}`.trim()
    setQuery(nextQuery)
    handleRun(nextQuery)
  }

  const handleRemoveFilter = (filter: FacetToken) => {
    const nextQuery = removeRange(query, filter.start, filter.end)
    setQuery(nextQuery)
    handleRun(nextQuery)
  }

  const handleExport = async () => {
    const app = appRef.current
    const viewUUID = viewUUIDRef.current
    if (!app || !viewUUID) {
      return
    }
    setExporting(true)
    setExportPath(null)
    setExportOpenError(null)
    try {
      const exported = await exportReport(app, viewUUID, { title: result?.params.title })
      if (exported.ok && exported.path) {
        setExportPath(exported.path)
        setExportOpenError(exported.openError ?? null)
      } else {
        setError(exported.error ?? 'エクスポートに失敗しました')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  // CSV/JSON of the rows currently shown (all local filters applied).
  const handleExportData = async (format: 'csv' | 'json') => {
    const app = appRef.current
    const viewUUID = viewUUIDRef.current
    if (!app || !viewUUID || exportingData) {
      return
    }
    setExportingData(format)
    setExportPath(null)
    setExportOpenError(null)
    try {
      const exported = await exportReport(app, viewUUID, {
        title: result?.params.title,
        format,
        rowIds: filteredRows.map((row) => row.id),
      })
      if (exported.ok && exported.path) {
        setExportPath(exported.path)
      } else {
        setError(exported.error ?? 'エクスポートに失敗しました')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExportingData(null)
    }
  }

  const handleToggleFullscreen = () => {
    if (fullscreen) void displayMode.requestInline()
    else void displayMode.requestFullscreen()
  }

  if (phase === 'connecting' || phase === 'waiting' || phase === 'loading') {
    return (
      <CenteredNotice>
        <Loader2 className="size-4 animate-spin" />
        {phase === 'loading' ? '調査データを読み込み中…' : '調査データを待っています…'}
      </CenteredNotice>
    )
  }

  if (phase === 'expired') {
    return (
      <CenteredNotice>
        <CircleAlert className="size-4 text-status-warn" />
        この調査セッションは期限切れです。アシスタントに datadog_investigate_logs の再実行を依頼してください。
      </CenteredNotice>
    )
  }

  if (phase === 'error' || !result) {
    return (
      <CenteredNotice>
        <CircleAlert className="size-4 text-status-error" />
        <span className="whitespace-pre-wrap">{error ?? '問題が発生しました。'}</span>
      </CenteredNotice>
    )
  }

  return (
    <div
      data-display-mode={displayMode.displayMode}
      className={cn(
        'flex flex-col gap-3 p-3',
        // Inline mode must not tie min-height to the viewport: the host sizes the
        // iframe from our size-changed notifications, so a viewport-based minimum
        // would ratchet the measured height up and never let it shrink back.
        fullscreen && 'h-svh min-h-0 overflow-y-auto md:overflow-hidden'
      )}
    >
      <QueryBar
        query={query}
        from={from}
        to={to}
        running={running}
        exporting={exporting}
        fullscreen={fullscreen}
        canFullscreen={displayMode.canFullscreen}
        onQueryChange={setQuery}
        onRangeChange={(f, t) => {
          setFrom(f)
          setTo(t)
        }}
        onRun={() => handleRun()}
        onExport={handleExport}
        onToggleFullscreen={handleToggleFullscreen}
      />

      {activeFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">絞り込み中:</span>
          {activeFilters.map((filter) => (
            <button
              key={`${filter.start}:${filter.token}`}
              type="button"
              onClick={() => handleRemoveFilter(filter)}
              title="このフィルタを解除"
              className="flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 pl-2.5 pr-1.5 hover:bg-accent"
            >
              <span className="text-muted-foreground">{FACET_META[filter.facet]?.label ?? filter.facet}:</span>
              <span className="max-w-40 truncate font-medium">{filter.value}</span>
              <X className="size-3 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-status-error" />
          <span className="whitespace-pre-wrap">{error}</span>
        </div>
      )}

      {(result.notices ?? []).length > 0 && (
        <div className="space-y-0.5 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {(result.notices ?? []).map((notice) => (
            <div key={notice}>{notice}</div>
          ))}
        </div>
      )}

      {exportPath && (
        <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <div>
            レポートを書き出しました: <code className="font-mono">{exportPath}</code>
          </div>
          {exportOpenError && (
            <div className="flex items-start gap-1.5 text-muted-foreground">
              <CircleAlert className="mt-0.5 size-3 shrink-0 text-status-warn" />
              <span>ブラウザで開けませんでした: {exportOpenError}</span>
            </div>
          )}
        </div>
      )}

      {result.findings && (
        <Card className="shrink-0 py-3">
          <CardContent className="px-3">
            <Collapsible defaultOpen>
              <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <NotebookPen className="size-3.5" aria-hidden />
                AI の調査メモ
                <ChevronDown
                  className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90"
                  aria-hidden
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1.5">
                <Markdown>{result.findings}</Markdown>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
      )}

      <div className="text-xs text-muted-foreground">
        約 {result.totalCount.toLocaleString('ja-JP')} 件が該当 · {result.rows.length} 件を取得済み
        {result.params.title ? ` · ${result.params.title}` : ''}
      </div>

      <ComparisonPanel comparison={result.comparison} />

      <div
        className={cn(
          'grid grid-cols-1 gap-3 md:grid-cols-[13rem_1fr]',
          fullscreen && 'md:min-h-0 md:flex-1 md:overflow-hidden'
        )}
      >
        <FacetSidebar
          facets={result.facets}
          activeKeys={activeKeys}
          onSelect={handleFacetSelect}
          className={fullscreen ? 'md:min-h-0 md:overflow-auto md:pr-1' : undefined}
        />
        <div className={cn('flex min-w-0 flex-col gap-3', fullscreen && 'md:min-h-0 md:overflow-hidden')}>
          <Card className="shrink-0 py-3">
            <CardContent className="px-3">
              <TimelineChart
                timeline={result.timeline}
                interval={result.interval}
                rangeMs={result.resolvedRange.toMs - result.resolvedRange.fromMs}
                selectedBucket={effectiveBucket}
                onBucketSelect={setSelectedBucket}
                events={result.events}
                onsetTime={result.comparison?.onset?.time}
              />
            </CardContent>
          </Card>
          <EventList events={result.events ?? []} timeline={result.timeline} onSelectBucket={setSelectedBucket} />
          <MetricsPanel metrics={result.metrics ?? []} />
          <PatternList
            patterns={result.patterns ?? []}
            analyzedCount={result.rows.length}
            selectedTemplate={activePattern?.template ?? null}
            onSelect={setSelectedPattern}
          />
          <Card className={cn('py-1', fullscreen && 'md:min-h-0 md:flex-1 md:overflow-hidden')}>
            <CardContent className={cn('px-1', fullscreen && 'md:min-h-0 md:flex-1 md:overflow-auto')}>
              <div className="flex flex-wrap items-center gap-2 border-b px-2 pb-2 pt-1">
                <ListFilter className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <Input
                  value={localKeyword}
                  onChange={(e) => setLocalKeyword(e.target.value)}
                  placeholder="取得済みのログをキーワードで絞り込み（再検索なし）"
                  aria-label="取得済みログのキーワード絞り込み"
                  className="h-7 w-80 max-w-full text-xs"
                />
                {bucketRange && (
                  <button
                    type="button"
                    onClick={() => setSelectedBucket(null)}
                    title="時間帯の絞り込みを解除"
                    className="flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 pl-2.5 pr-1.5 text-xs hover:bg-accent"
                  >
                    <span className="text-muted-foreground">時間帯:</span>
                    <span className="font-medium">{formatBucketRange(bucketRange)}</span>
                    <X className="size-3 text-muted-foreground" />
                  </button>
                )}
                {activePattern && (
                  <button
                    type="button"
                    onClick={() => setSelectedPattern(null)}
                    title="パターンの絞り込みを解除"
                    className="flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 pl-2.5 pr-1.5 text-xs hover:bg-accent"
                  >
                    <span className="text-muted-foreground">パターン:</span>
                    <span className="max-w-48 truncate font-mono font-medium">{activePattern.template}</span>
                    <X className="size-3 text-muted-foreground" />
                  </button>
                )}
                {localFilterActive && (
                  <span className="text-[11px] text-muted-foreground">
                    取得済み {result.rows.length} 件中 {filteredRows.length} 件を表示
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  {(['csv', 'json'] as const).map((format) => (
                    <Button
                      key={format}
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      disabled={Boolean(exportingData) || filteredRows.length === 0}
                      title={`表示中の ${filteredRows.length} 件を ${format.toUpperCase()} で書き出し`}
                      onClick={() => void handleExportData(format)}
                    >
                      {exportingData === format ? <Loader2 className="animate-spin" /> : <FileDown aria-hidden />}
                      {format.toUpperCase()}
                    </Button>
                  ))}
                </div>
              </div>
              <LogTable
                rows={filteredRows}
                highlightTerms={keywordTerms}
                hasMore={Boolean(result.nextCursor)}
                loadingMore={loadingMore}
                onLoadMore={() => void loadMore()}
                emptyMessage={
                  localFilterActive ? '絞り込み条件に一致するログは取得済みデータにありません。' : undefined
                }
                fetchDetail={async (logId) => {
                  const app = appRef.current
                  const viewUUID = viewUUIDRef.current
                  if (!app || !viewUUID) {
                    return null
                  }
                  return fetchLogDetail(app, viewUUID, logId)
                }}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function CenteredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">{children}</div>
    </div>
  )
}

function quoteValue(value: string): string {
  if (/^[\w.\-/:]+$/.test(value)) {
    return value
  }
  return `"${value.replace(/"/g, '\\"')}"`
}

interface FacetToken {
  facet: string
  value: string
  token: string
  /** Character range of the token within the query string */
  start: number
  end: number
}

const FACET_TOKEN_RE = /(^|\s)([\w@.-]+):("(?:[^"\\]|\\.)*"|\S+)/g

function parseFacetTokens(query: string): FacetToken[] {
  const tokens: FacetToken[] = []
  for (const match of query.matchAll(FACET_TOKEN_RE)) {
    const [, lead, facet, rawValue] = match
    const start = (match.index ?? 0) + lead.length
    const token = `${facet}:${rawValue}`
    tokens.push({ facet, value: unquoteValue(rawValue), token, start, end: start + token.length })
  }
  return tokens
}

function unquoteValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"')
  }
  return raw
}

function removeRange(query: string, start: number, end: number): string {
  return (query.slice(0, start) + query.slice(end)).replace(/\s+/g, ' ').trim()
}

interface BucketRange {
  startMs: number
  endMs: number
}

function intervalToMs(interval: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(interval.trim())
  if (!match) {
    return 0
  }
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd']
  return Number(match[1]) * unitMs
}

function resolveBucketRange(
  timeline: TimelineBucket[],
  bucketTime: string,
  interval: string,
  rangeEndMs: number
): BucketRange | null {
  const startMs = Date.parse(bucketTime)
  if (Number.isNaN(startMs)) {
    return null
  }
  const intervalMs = intervalToMs(interval)
  if (intervalMs > 0) {
    return { startMs, endMs: startMs + intervalMs }
  }
  // Unknown interval format: fall back to the next bucket's start (or the range end).
  const index = timeline.findIndex((b) => b.time === bucketTime)
  const nextMs = index >= 0 && index + 1 < timeline.length ? Date.parse(timeline[index + 1].time) : NaN
  return { startMs, endMs: Number.isNaN(nextMs) ? rangeEndMs : nextMs }
}

function formatBucketRange({ startMs, endMs }: BucketRange): string {
  const start = new Date(startMs)
  const end = new Date(endMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${start.getMonth() + 1}/${start.getDate()} ${hhmm(start)}〜${hhmm(end)}`
}
