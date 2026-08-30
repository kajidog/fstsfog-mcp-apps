import { ChevronDown, LineChart as LineChartIcon, Loader2, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'

/** Server-side cap on metricsQueries (see MAX_METRICS_QUERIES / the _run_investigation schema). */
const MAX_QUERIES = 4

const PLACEHOLDER = 'avg:system.cpu.user{service:payments}'

interface MetricsQueryEditorProps {
  /** Metric queries the current result was fetched with */
  queries: string[]
  running: boolean
  /** Re-runs the investigation with these queries; an empty array clears the metrics. */
  onApply: (queries: string[]) => void
}

/**
 * Always-rendered editor for the investigation's metric queries. Kept separate
 * from MetricsPanel so that panel stays a pure display that renders nothing
 * when no series came back.
 */
export function MetricsQueryEditor({ queries, running, onApply }: MetricsQueryEditorProps) {
  const applied = queries.join('\n')
  const [drafts, setDrafts] = useState<string[]>(queries.length > 0 ? queries : [''])
  // Re-sync whenever the server's queries change (a re-run, a load-more, or
  // another surface editing them) so the inputs never drift from the result.
  useEffect(() => {
    setDrafts(applied.length > 0 ? applied.split('\n') : [''])
  }, [applied])

  const cleaned = drafts.map((q) => q.trim()).filter(Boolean)
  const dirty = cleaned.join('\n') !== applied

  const setAt = (index: number, value: string) => {
    setDrafts((prev) => prev.map((q, i) => (i === index ? value : q)))
  }
  const removeAt = (index: number) => {
    setDrafts((prev) => {
      const next = prev.filter((_, i) => i !== index)
      return next.length > 0 ? next : ['']
    })
  }

  return (
    <Card className="shrink-0 py-3">
      <CardContent className="px-3">
        <Collapsible defaultOpen={queries.length > 0}>
          <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <LineChartIcon className="size-3.5" aria-hidden />
            メトリクスクエリ（{queries.length}件）
            <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-1.5">
            {drafts.map((draft, index) => (
              // Inputs are positional: the index is the only stable identity here.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional inputs
              <div key={index} className="flex items-center gap-1.5">
                <Input
                  value={draft}
                  onChange={(e) => setAt(index, e.target.value)}
                  placeholder={PLACEHOLDER}
                  aria-label={`メトリクスクエリ ${index + 1}`}
                  className="h-7 font-mono text-xs"
                />
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`メトリクスクエリ ${index + 1} を削除`}
                  title="この行を削除"
                  onClick={() => removeAt(index)}
                >
                  <X />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground"
                disabled={drafts.length >= MAX_QUERIES}
                title={drafts.length >= MAX_QUERIES ? `メトリクスクエリは最大 ${MAX_QUERIES} 件です` : '行を追加'}
                onClick={() => setDrafts((prev) => [...prev, ''])}
              >
                <Plus aria-hidden />
                行を追加
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7 px-3 text-xs"
                disabled={running || !dirty}
                title={cleaned.length === 0 ? 'メトリクスを外して再検索します' : 'このメトリクスクエリで再検索します'}
                onClick={() => onApply(cleaned)}
              >
                {running && <Loader2 className="animate-spin" />}
                {cleaned.length === 0 ? 'メトリクスを外して再検索' : '適用して再検索'}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                ログと同じ期間で取得します（最大 {MAX_QUERIES} 件）。失敗したクエリは上部の通知に表示されます。
              </span>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}
