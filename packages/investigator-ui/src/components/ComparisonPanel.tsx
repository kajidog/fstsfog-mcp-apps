import type {
  ComparisonResult,
  EventMarkerKind,
  FacetAttribution,
  OnsetDetection,
  OnsetEvent,
  PatternDiff,
  PatternDiffKind,
  VolumeComparison,
} from '@kajidog/investigation-shared'
import { ChevronDown, GitCompareArrows } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

const MAX_STATUSES = 6
const MAX_PATTERNS = 8
const MAX_FACET_VALUES = 5
const MAX_NEARBY_EVENTS = 3
const MAX_TEMPLATE_CHARS = 160
const INTERVAL_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
/** 8.64e15 is the Date range limit; formatting past it throws. */
const MAX_TIME_MS = 8.64e15

const STATUS_BADGE_CLASS: Record<string, string> = {
  error: 'bg-status-error text-white',
  warn: 'bg-status-warn text-black',
  info: 'bg-status-info text-white',
  debug: 'bg-status-debug text-white',
}

/** Badge colours mirror the HTML report: looked up per kind, never derived from the data. */
const PATTERN_KIND_CLASS: Record<PatternDiffKind, string> = {
  new: 'bg-status-error text-white',
  spiking: 'bg-event-alert text-white',
  dropping: 'bg-status-info text-white',
  gone: 'bg-status-debug text-white',
}

const PATTERN_KIND_LABEL: Record<PatternDiffKind, string> = {
  new: '新規',
  spiking: '増加',
  dropping: '減少',
  gone: '消滅',
}

const EVENT_KIND_CLASS: Record<EventMarkerKind, string> = {
  deploy: 'bg-event-deploy text-white',
  alert: 'bg-event-alert text-white',
  other: 'bg-event-other text-white',
}

const EVENT_KIND_LABEL: Record<EventMarkerKind, string> = {
  deploy: 'デプロイ',
  alert: 'アラート',
  other: 'イベント',
}

interface ComparisonPanelProps {
  comparison: ComparisonResult | undefined
}

/**
 * Baseline comparison for the investigated window, mirroring what the HTML
 * report renders. Every number that can be null/Infinity on the wire (ratios,
 * lifts, sigmas) goes through a guarded formatter, so the panel never shows
 * "Infinity"/"NaN"/"undefined" to the reader.
 */
export function ComparisonPanel({ comparison }: ComparisonPanelProps) {
  if (!comparison || !hasContent(comparison)) {
    return null
  }
  const { params, target, baseline, volume } = comparison
  // A large volume ratio with a flat error rate is a traffic surge, not an
  // incident, so the error-rate tiles sit right next to the volume ones.
  const errorWorse = Number.isFinite(volume.errorRateDelta) && volume.errorRateDelta > 0
  const meta =
    `ベースライン: ${modeLabel(params)} · 対象 ${timeRangeText(target.fromMs, target.toMs)}` +
    ` · 基準 ${timeRangeText(baseline.fromMs, baseline.toMs)} · ${comparison.interval} ごとの集計`
  return (
    <Card className="shrink-0 py-3">
      <CardContent className="px-3">
        <Collapsible defaultOpen>
          <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <GitCompareArrows className="size-3.5" aria-hidden />
            ベースライン比較
            <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-3">
            <p className="text-[11px] leading-snug text-muted-foreground">
              {meta}
              {params.scope ? (
                <>
                  {' · パターン抽出条件: '}
                  <code className="font-mono">{params.scope}</code>
                </>
              ) : null}
            </p>

            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Tile
                label="対象期間のログ数"
                value={countText(target.totalCount)}
                sub={`ベースライン ${countText(baseline.totalCount)}（${signedCountText(volume.total.delta)}）`}
              />
              <Tile label="件数の変化" value={ratioText(volume.total.ratio)} sub="対象 ÷ ベースライン" />
              <Tile
                label="エラー率"
                value={percentText(target.errorRate)}
                sub={`ベースライン ${percentText(baseline.errorRate)}`}
                emphasize={errorWorse}
              />
              <Tile
                label="エラー率の変化"
                value={ratePointsText(volume.errorRateDelta)}
                sub="パーセントポイント"
                emphasize={errorWorse}
              />
            </div>

            <StatusSection volume={volume} />
            <OnsetSection comparison={comparison} />
            <PatternSection patterns={comparison.patterns} />
            {(comparison.facets ?? []).map((facet) => (
              <FacetSection key={facet.facet} attribution={facet} />
            ))}
            <NoticeSection notices={comparison.notices} />
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}

/** Nothing worth showing when both windows are empty and no sub-analysis landed. */
function hasContent(comparison: ComparisonResult): boolean {
  return (
    comparison.target.totalCount > 0 ||
    comparison.baseline.totalCount > 0 ||
    comparison.onset !== undefined ||
    (comparison.patterns?.length ?? 0) > 0 ||
    (comparison.facets ?? []).some((facet) => facet.values.length > 0) ||
    (comparison.notices?.length ?? 0) > 0
  )
}

function Tile({ label, value, sub, emphasize }: { label: string; value: string; sub: string; emphasize?: boolean }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('text-sm font-medium tabular-nums', emphasize && 'text-status-error')}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{sub}</div>
    </div>
  )
}

function Subsection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">{title}</div>
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      {children}
    </div>
  )
}

function StatusSection({ volume }: { volume: VolumeComparison }) {
  const statuses = volume.byStatus
    .filter((status) => status.targetCount > 0 || status.baselineCount > 0)
    .slice()
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, MAX_STATUSES)
  if (statuses.length === 0) {
    return null
  }
  return (
    <Subsection title="ステータス別の件数">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="h-7 px-2 text-[11px]">ステータス</TableHead>
            <TableHead className="h-7 px-2 text-right text-[11px]">対象</TableHead>
            <TableHead className="h-7 px-2 text-right text-[11px]">ベースライン</TableHead>
            <TableHead className="h-7 px-2 text-right text-[11px]">差分</TableHead>
            <TableHead className="h-7 px-2 text-right text-[11px]">比率</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {statuses.map((status) => (
            <TableRow key={status.status}>
              <TableCell className="p-1.5">
                <Badge className={cn('px-1.5 py-0 text-[10px]', STATUS_BADGE_CLASS[status.status] ?? 'bg-muted')}>
                  {status.status}
                </Badge>
              </TableCell>
              <TableCell className="p-1.5 text-right tabular-nums">{countText(status.targetCount)}</TableCell>
              <TableCell className="p-1.5 text-right tabular-nums">{countText(status.baselineCount)}</TableCell>
              <TableCell className="p-1.5 text-right tabular-nums">{signedCountText(status.delta)}</TableCell>
              <TableCell className="p-1.5 text-right tabular-nums">{ratioText(status.ratio)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Subsection>
  )
}

function OnsetSection({ comparison }: { comparison: ComparisonResult }) {
  const onset = comparison.onset
  if (!onset) {
    return null
  }
  const events = [
    ...(onset.precedingEvent ? [{ entry: onset.precedingEvent, label: '直前' }] : []),
    ...(onset.nearbyEvents ?? []).slice(0, MAX_NEARBY_EVENTS).map((entry) => ({ entry, label: '周辺' })),
  ]
  return (
    <Subsection title={`異常の始まり ${isoTimeText(onset.time)}`}>
      <p className="text-[11px] leading-snug text-muted-foreground">{onsetDetailText(comparison, onset)}</p>
      {events.length > 0 && (
        <ul className="space-y-0.5">
          {events.map(({ entry, label }) => (
            <li
              key={`${label}:${entry.event.id || entry.event.time}`}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
            >
              <span className="w-8 shrink-0 text-[11px] text-muted-foreground">{label}</span>
              <Badge className={cn('shrink-0 px-1.5 py-0 text-[10px]', EVENT_KIND_CLASS[entry.event.kind])}>
                {EVENT_KIND_LABEL[entry.event.kind]}
              </Badge>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {isoTimeText(entry.event.time)}
              </span>
              <span className="min-w-0 break-words">
                {entry.event.source ? `${entry.event.source} — ` : ''}
                {entry.event.title}
              </span>
              <span className="text-[11px] text-muted-foreground">{leadTimeText(entry)}</span>
            </li>
          ))}
        </ul>
      )}
    </Subsection>
  )
}

function PatternSection({ patterns }: { patterns: PatternDiff[] | undefined }) {
  if (!patterns || patterns.length === 0) {
    return null
  }
  const shown = patterns.slice(0, MAX_PATTERNS)
  const rest = patterns.length - shown.length
  return (
    <Subsection
      title={`変化したメッセージパターン${rest > 0 ? `（上位 ${shown.length} 件）` : ''}`}
      hint="対象/ベースラインの件数はサンプルから期間全体に換算した推定値です。"
    >
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="h-7 px-2 text-[11px]">種別</TableHead>
            <TableHead className="h-7 px-2 text-right text-[11px]">対象</TableHead>
            <TableHead className="h-7 px-2 text-right text-[11px]">ベースライン</TableHead>
            <TableHead className="h-7 px-2 text-right text-[11px]">変化</TableHead>
            <TableHead className="h-7 px-2 text-[11px]">テンプレート</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((diff) => (
            <TableRow key={`${diff.kind}:${diff.template}`}>
              <TableCell className="p-1.5">
                <Badge className={cn('px-1.5 py-0 text-[10px]', PATTERN_KIND_CLASS[diff.kind] ?? 'bg-muted')}>
                  {PATTERN_KIND_LABEL[diff.kind] ?? diff.kind}
                </Badge>
              </TableCell>
              <TableCell className="p-1.5 text-right tabular-nums">約 {countText(diff.estimatedTargetCount)}</TableCell>
              <TableCell className="p-1.5 text-right tabular-nums">
                約 {countText(diff.estimatedBaselineCount)}
              </TableCell>
              <TableCell className="p-1.5 text-right tabular-nums">{patternChangeText(diff)}</TableCell>
              <TableCell className="max-w-80 whitespace-normal p-1.5 font-mono break-words" title={diff.example}>
                {templateText(diff.template)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rest > 0 && <p className="text-[11px] text-muted-foreground">ほかに {rest} 件のテンプレートが変化</p>}
    </Subsection>
  )
}

function FacetSection({ attribution }: { attribution: FacetAttribution }) {
  if (attribution.values.length === 0) {
    return null
  }
  const scale = attribution.baselineCovered > 0 ? attribution.targetCovered / attribution.baselineCovered : null
  const hint =
    scale === null
      ? 'ベースライン期間に該当ログがないため、すべて新しい値です。'
      : `超過 = ベースラインを一律 ${ratioText(scale)} に増やした場合の予測を超えた件数です。`
  const shown = attribution.values.slice(0, MAX_FACET_VALUES)
  const rest = attribution.values.length - shown.length
  return (
    <Subsection title={`${attribution.facet} の寄与`} hint={hint}>
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="h-7 px-2 text-[11px]">値</TableHead>
            <TableHead className="h-7 px-2 text-right text-[11px]">対象</TableHead>
            <TableHead className="h-7 px-2 text-right text-[11px]">ベースライン</TableHead>
            <TableHead className="h-7 px-2 text-right text-[11px]">超過</TableHead>
            <TableHead className="h-7 px-2 text-right text-[11px]">シェア</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((value) => (
            <TableRow key={value.value}>
              <TableCell className="max-w-56 whitespace-normal p-1.5 break-words">
                <span>{value.value}</span>
                {/* baselineTruncated means the baseline tail was cut off, so a 0 count is a
                    lower bound — calling that value new would be a claim the data cannot make. */}
                {value.baselineTruncated ? (
                  <span className="ml-1.5 rounded-full border px-1.5 py-0 text-[10px] text-muted-foreground">
                    ベースラインでは希少
                  </span>
                ) : value.isNew ? (
                  <span className="ml-1.5 rounded-full border border-status-error px-1.5 py-0 text-[10px] text-status-error">
                    NEW
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="p-1.5 text-right tabular-nums">{countText(value.targetCount)}</TableCell>
              <TableCell className="p-1.5 text-right tabular-nums">{countText(value.baselineCount)}</TableCell>
              <TableCell className="p-1.5 text-right tabular-nums">{signedCountText(value.excess)}</TableCell>
              <TableCell className="p-1.5 text-right tabular-nums">
                {percentText(value.targetShare)} ⇔ {percentText(value.baselineShare)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rest > 0 && <p className="text-[11px] text-muted-foreground">ほかに {rest} 件の値</p>}
    </Subsection>
  )
}

function NoticeSection({ notices }: { notices: string[] | undefined }) {
  if (!notices || notices.length === 0) {
    return null
  }
  return (
    <div className="space-y-0.5 rounded-md border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
      {notices.map((notice) => (
        <div key={notice}>{notice}</div>
      ))}
    </div>
  )
}

function modeLabel(params: ComparisonResult['params']): string {
  if (params.mode === 'shift') {
    return params.shift ? `${params.shift} 前と比較` : 'シフト比較'
  }
  return params.mode === 'custom' ? '指定期間と比較' : '直前の同じ長さの期間と比較'
}

function onsetDetailText(comparison: ComparisonResult, onset: OnsetDetection): string {
  const total = bucketCount(comparison)
  const index = Number.isFinite(onset.bucketIndex) ? Math.round(onset.bucketIndex) + 1 : null
  const position =
    index === null ? '' : total === undefined ? `${index} 番目のバケット` : `${index}/${total} 番目のバケット`
  const sigmas = onset.sigmas !== null && Number.isFinite(onset.sigmas) ? `（${onset.sigmas.toFixed(1)}σ）` : ''
  const sustained = Number.isFinite(onset.sustainedBuckets) ? `${Math.round(onset.sustainedBuckets)}` : '-'
  return (
    [position, `エラー率 ${percentText(onset.errorRate)}`].filter(Boolean).join(' · ') +
    ` · ベースライン平均 ${percentText(onset.baselineMean)} ± ${percentText(onset.baselineStdev)}` +
    ` · しきい値 ${percentText(onset.threshold)}${sigmas} · ${sustained} バケット継続`
  )
}

/** Total buckets in the target window; undefined when the interval is unparseable. */
function bucketCount(comparison: ComparisonResult): number | undefined {
  const match = /^(\d+)([smhd])$/.exec(comparison.interval)
  const unitMs = match ? INTERVAL_UNIT_MS[match[2]] : undefined
  if (!match || unitMs === undefined) {
    return undefined
  }
  const intervalMs = Number(match[1]) * unitMs
  const span = comparison.target.toMs - comparison.target.fromMs
  if (!Number.isFinite(span) || intervalMs <= 0 || span <= 0) {
    return undefined
  }
  return Math.ceil(span / intervalMs)
}

/** leadTimeMs is onset - event: positive means the event landed first. */
function leadTimeText(entry: OnsetEvent): string {
  if (!Number.isFinite(entry.leadTimeMs)) {
    return ''
  }
  return entry.leadTimeMs >= 0 ? `${durationText(entry.leadTimeMs)}前` : `${durationText(entry.leadTimeMs)}後`
}

function patternChangeText(diff: PatternDiff): string {
  if (diff.kind === 'new') {
    return `対象サンプルの ${percentText(diff.targetRatio)}`
  }
  if (diff.kind === 'gone') {
    return `ベースラインサンプルの ${percentText(diff.baselineRatio)}`
  }
  return ratioText(diff.lift)
}

/**
 * A multiplier. `null` on the wire means the baseline side was 0 — rendering it
 * as a number would print Infinity or NaN, so it is spelled out instead.
 */
function ratioText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'ベースライン0件'
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)}倍`
}

function countText(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value).toLocaleString('ja-JP')}件` : '-'
}

function signedCountText(value: number): string {
  if (!Number.isFinite(value)) {
    return '-'
  }
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('ja-JP')}`
}

/** A 0–1 rate as a percentage. */
function percentText(rate: number): string {
  return Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : '-'
}

/** A rate delta in percentage points, always signed. */
function ratePointsText(delta: number): string {
  if (!Number.isFinite(delta)) {
    return '-'
  }
  const points = delta * 100
  return `${points > 0 ? '+' : ''}${points.toFixed(1)} ポイント`
}

function durationText(ms: number): string {
  const abs = Math.abs(ms)
  if (!Number.isFinite(abs)) {
    return '?'
  }
  if (abs < 60_000) {
    return `${Math.round(abs / 1000)}秒`
  }
  if (abs < 3_600_000) {
    return `${Math.round(abs / 60_000)}分`
  }
  if (abs < 86_400_000) {
    return `${Math.round(abs / 3_600_000)}時間`
  }
  return `${Math.round(abs / 86_400_000)}日`
}

function templateText(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_TEMPLATE_CHARS ? `${collapsed.slice(0, MAX_TEMPLATE_CHARS)}…` : collapsed
}

function timeRangeText(fromMs: number, toMs: number): string {
  return `${epochTimeText(fromMs)} 〜 ${epochTimeText(toMs)}`
}

/** Formats an epoch ms boundary, guarding the values Date would choke on. */
function epochTimeText(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_TIME_MS) {
    return '(不明)'
  }
  return formatDate(new Date(ms))
}

function isoTimeText(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : formatDate(date)
}

function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
