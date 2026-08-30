import type { EventMarker, EventMarkerKind, TimelineBucket } from '@kajidog/investigation-shared'
import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceArea, ReferenceLine, XAxis, YAxis } from 'recharts'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { computeRangeFromDrag, snapToBucket } from '@/lib/timeline'

/** Bottom-to-top stack order; statuses outside this set fold into "other". */
const STACK_ORDER = ['debug', 'info', 'warn', 'error'] as const

const chartConfig = {
  debug: { label: 'debug', color: 'var(--status-debug)' },
  info: { label: 'info', color: 'var(--status-info)' },
  warn: { label: 'warn', color: 'var(--status-warn)' },
  error: { label: 'error', color: 'var(--status-error)' },
  other: { label: 'other', color: 'var(--status-other)' },
} satisfies ChartConfig

const EVENT_COLOR: Record<EventMarkerKind, string> = {
  deploy: 'var(--event-deploy)',
  alert: 'var(--event-alert)',
  other: 'var(--event-other)',
}

/** The onset marker: solid, and the only line drawn in the error colour. */
const ONSET_COLOR = 'var(--status-error)'

const EVENT_KIND_LABEL: Record<EventMarkerKind, string> = {
  deploy: 'デプロイ',
  alert: 'アラート',
  other: 'イベント',
}

interface TimelineChartProps {
  timeline: TimelineBucket[]
  interval: string
  rangeMs: number
  /** End of the investigated window (epoch ms) — caps a dragged range */
  rangeEndMs: number
  /** Bucket time (ISO) currently selected as a table filter, if any */
  selectedBucket: string | null
  onBucketSelect: (time: string | null) => void
  /** Drag across buckets: re-query the server for the dragged window (ISO 8601, zoned) */
  onRangeSelect?: (fromIso: string, toIso: string) => void
  /** Events overlaid as vertical reference lines (snapped to the nearest bucket) */
  events?: EventMarker[]
  /** Detected onset time (ISO), drawn as its own reference line */
  onsetTime?: string
}

export function TimelineChart({
  timeline,
  interval,
  rangeMs,
  rangeEndMs,
  selectedBucket,
  onBucketSelect,
  onRangeSelect,
  events,
  onsetTime,
}: TimelineChartProps) {
  // Drag endpoints as bucket times. A press with no move (or a move back onto
  // the pressed bucket) is a click, and keeps the existing single-bucket toggle.
  const [dragStart, setDragStart] = useState<string | null>(null)
  const [dragEnd, setDragEnd] = useState<string | null>(null)
  const { data, keys } = useMemo(() => {
    const present = new Set<string>()
    const rows = timeline.map((bucket) => {
      const row: Record<string, number | string> = { time: bucket.time }
      for (const [status, count] of Object.entries(bucket.counts)) {
        const key = (STACK_ORDER as readonly string[]).includes(status) ? status : 'other'
        row[key] = ((row[key] as number) ?? 0) + count
        if (count > 0) {
          present.add(key)
        }
      }
      return row
    })
    const ordered = [...STACK_ORDER.filter((s) => present.has(s)), ...(present.has('other') ? ['other'] : [])]
    return { data: rows, keys: ordered }
  }, [timeline])

  // The XAxis is categorical, so ReferenceLine x must be an exact bucket time:
  // each marker snaps to its nearest bucket (positions are bucket ±interval).
  const buckets = useMemo(
    () => timeline.map((b) => ({ time: b.time, ms: Date.parse(b.time) })).filter((b) => !Number.isNaN(b.ms)),
    [timeline]
  )

  const eventLines = useMemo(() => {
    const list = events ?? []
    if (list.length === 0 || buckets.length === 0) {
      return []
    }
    const lines: Array<{ key: string; x: string; kind: EventMarkerKind }> = []
    for (const event of list) {
      const x = snapToBucket(buckets, event.time)
      if (x === null) {
        continue
      }
      lines.push({ key: event.id || `${event.time}:${event.kind}`, x, kind: event.kind })
    }
    return lines
  }, [events, buckets])
  const eventKinds = useMemo(() => [...new Set(eventLines.map((line) => line.kind))], [eventLines])

  // The onset is the bucket where the error rate starts departing from the
  // baseline: one line, distinct from the dashed event markers.
  const onsetLine = useMemo(() => (onsetTime ? snapToBucket(buckets, onsetTime) : null), [onsetTime, buckets])

  const withDate = rangeMs > 86_400_000

  if (timeline.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        この範囲にログはありません
      </div>
    )
  }

  return (
    <div>
      <ChartContainer config={chartConfig} className="h-40 w-full [&_.recharts-bar-rectangle]:cursor-pointer">
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
          // No onClick handler: recharts fires it after onMouseUp, so wiring both
          // would run the single-bucket toggle twice per click.
          onMouseDown={(state) => {
            const label = state?.activeLabel
            if (typeof label === 'string') {
              setDragStart(label)
              setDragEnd(null)
            }
          }}
          onMouseMove={(state) => {
            if (dragStart === null) {
              return
            }
            const label = state?.activeLabel
            if (typeof label === 'string' && label !== dragEnd) {
              setDragEnd(label)
            }
          }}
          onMouseUp={() => {
            const start = dragStart
            const end = dragEnd
            setDragStart(null)
            setDragEnd(null)
            if (start === null) {
              return
            }
            if (end === null || end === start) {
              onBucketSelect(start === selectedBucket ? null : start)
              return
            }
            const range = computeRangeFromDrag(start, end, interval, rangeEndMs)
            if (range) {
              onRangeSelect?.(range.fromIso, range.toIso)
            }
          }}
          // Leaving the plot cancels the drag; without this a mouseup outside
          // would leave the preview stuck on screen. (Mouse only for now —
          // touch drag is a follow-up.)
          onMouseLeave={() => {
            setDragStart(null)
            setDragEnd(null)
          }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="time"
            tickLine={false}
            axisLine={false}
            minTickGap={40}
            tickFormatter={(value: string) => formatTick(value, withDate)}
            fontSize={11}
          />
          <YAxis tickLine={false} axisLine={false} width={40} fontSize={11} allowDecimals={false} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(value) => formatTick(String(value), true)} />} />
          {eventLines.map((line) => (
            <ReferenceLine
              key={line.key}
              x={line.x}
              stroke={EVENT_COLOR[line.kind]}
              strokeDasharray="3 3"
              strokeOpacity={0.8}
              strokeWidth={1.5}
            />
          ))}
          {onsetLine !== null && <ReferenceLine x={onsetLine} stroke={ONSET_COLOR} strokeWidth={2} />}
          {dragStart !== null && dragEnd !== null && dragEnd !== dragStart && (
            <ReferenceArea x1={dragStart} x2={dragEnd} fill="var(--status-info)" fillOpacity={0.15} strokeOpacity={0} />
          )}
          {keys.map((key, i) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="status"
              fill={`var(--color-${key})`}
              radius={i === keys.length - 1 ? [2, 2, 0, 0] : 0}
            >
              {data.map((row) => (
                <Cell key={String(row.time)} fillOpacity={selectedBucket && row.time !== selectedBucket ? 0.3 : 1} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ChartContainer>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {[...keys].reverse().map((key) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px]" style={{ background: `var(--status-${key})` }} />
            {key}
          </span>
        ))}
        {eventKinds.map((kind) => (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-0.5" style={{ background: EVENT_COLOR[kind] }} />
            {EVENT_KIND_LABEL[kind]}
          </span>
        ))}
        {onsetLine !== null && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-0.5" style={{ background: ONSET_COLOR }} />
            異常の始まり
          </span>
        )}
        <span className="text-[11px]">バーをクリックするとその時間帯だけ表に表示 · ドラッグした範囲で再検索</span>
        <span className="ml-auto">{interval} ごと</span>
      </div>
    </div>
  )
}

function formatTick(iso: string, withDate: boolean): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  if (withDate) {
    return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`
  }
  return `${hh}:${mm}`
}
