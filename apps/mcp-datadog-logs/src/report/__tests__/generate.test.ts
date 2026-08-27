import type { ComparisonResult, InvestigationResult } from '@kajidog/investigation-shared'
import { describe, expect, it } from 'vitest'
import { escapeHtml, generateReport } from '../generate.js'
import { renderTimelineSvg } from '../svg-timeline.js'

function fixtureResult(): InvestigationResult {
  return {
    params: { query: 'service:payments status:error', from: 'now-1h', to: 'now' },
    totalCount: 123,
    timeline: [
      { time: '2026-07-06T10:00:00.000Z', counts: { error: 5, info: 40 } },
      { time: '2026-07-06T10:05:00.000Z', counts: { error: 3, warn: 2 } },
    ],
    interval: '5m',
    facets: [
      { facet: 'service', values: [{ value: 'payments', count: 100 }], otherCount: 23 },
      {
        facet: 'status',
        values: [
          { value: 'error', count: 8 },
          { value: 'info', count: 115 },
        ],
      },
    ],
    rows: [
      {
        id: 'log-1',
        timestamp: '2026-07-06T10:01:00.000Z',
        status: 'error',
        service: 'payments',
        message: '<script>alert("xss")</script> failed',
      },
    ],
    fetchedAt: '2026-07-06T10:10:00.000Z',
    resolvedRange: { fromMs: Date.parse('2026-07-06T09:10:00Z'), toMs: Date.parse('2026-07-06T10:10:00Z') },
  }
}

describe('generateReport', () => {
  it('escapes log content (XSS)', () => {
    const html = generateReport(fixtureResult(), new Map())
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; failed')
  })

  it('includes query, stats, facets and log entries', () => {
    const html = generateReport(fixtureResult(), new Map(), { title: 'Payment errors', site: 'ap1.datadoghq.com' })
    expect(html).toContain('<title>Payment errors</title>')
    expect(html).toContain('service:payments status:error')
    expect(html).toContain('ap1.datadoghq.com')
    expect(html).toContain('payments')
    expect(html).toContain('Total logs')
    expect(html).toContain('<details data-status=')
  })

  it('renders AI findings as safe GFM Markdown', () => {
    const html = generateReport(
      {
        ...fixtureResult(),
        findings:
          '## Root cause\n\n- **Database timeout**\n- Retry exhausted\n\n| service | count |\n| --- | ---: |\n| api | 12 |\n\n[Runbook](https://example.com/runbook)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))',
      },
      new Map()
    )
    expect(html).toContain('AI Findings')
    expect(html).toContain('<h2>Root cause</h2>')
    expect(html).toContain('<strong>Database timeout</strong>')
    expect(html).toContain('<table>')
    expect(html).toContain('href="https://example.com/runbook" target="_blank" rel="noreferrer noopener"')
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&#x3C;script>alert(1)&#x3C;/script>')
    expect(html).not.toContain('href="javascript:')
  })

  it('omits the findings section when findings are absent', () => {
    expect(generateReport(fixtureResult(), new Map())).not.toContain('AI Findings')
  })

  it('renders escaped message patterns and omits the section when absent', () => {
    const withPatterns = generateReport(
      {
        ...fixtureResult(),
        patterns: [
          { template: '<script>boom</script> took <*>', count: 3, ratio: 0.75, example: 'boom took 3s', rowIds: [] },
        ],
      },
      new Map()
    )
    expect(withPatterns).toContain('Message patterns')
    expect(withPatterns).toContain('&lt;script&gt;boom&lt;/script&gt; took &lt;*&gt;')
    expect(withPatterns).not.toContain('<script>boom')
    expect(withPatterns).toContain('75%')

    expect(generateReport(fixtureResult(), new Map())).not.toContain('Message patterns')
  })

  it('includes raw detail JSON when available, truncated when huge', () => {
    const raw = { id: 'log-1', attributes: { message: 'y'.repeat(10_000) } }
    const html = generateReport(fixtureResult(), new Map([['log-1', raw]]))
    expect(html).toContain('… (truncated)')
  })

  it('includes the interactive filter UI and inline script', () => {
    const html = generateReport(fixtureResult(), new Map())
    expect(html).toContain('id="log-search"')
    expect(html).toContain('id="clear-filters"')
    expect(html).toContain('<script>')
    expect(html).toContain('localStorage.getItem(THEME_KEY)')
  })

  it('includes a theme toggle and explicit light/dark theme CSS', () => {
    const html = generateReport(fixtureResult(), new Map())
    expect(html).toContain('data-theme-value="light"')
    expect(html).toContain('data-theme-value="dark"')
    expect(html).toContain('data-theme-value="auto"')
    expect(html).toContain(':root[data-theme="dark"]')
    expect(html).toContain(':root:not([data-theme="light"])')
  })

  it('annotates log entries with data attributes for filtering', () => {
    const html = generateReport(fixtureResult(), new Map())
    const tsMs = Date.parse('2026-07-06T10:01:00.000Z')
    expect(html).toContain(`<details data-status="error" data-ts="${tsMs}">`)
  })

  it('renders legend statuses as toggle buttons', () => {
    const html = generateReport(fixtureResult(), new Map())
    expect(html).toContain('class="item" data-status="error"')
  })

  it('renders timestamps in UTC by default', () => {
    const html = generateReport(fixtureResult(), new Map())
    expect(html).toContain('data-time-zone="UTC"')
    expect(html).toContain('2026-07-06 09:10:00 → 2026-07-06 10:10:00 (UTC)')
    expect(html).toContain('<span class="time">2026-07-06 10:01:00</span>')
  })

  it('renders timestamps in the configured time zone', () => {
    const html = generateReport(fixtureResult(), new Map(), { timeZone: 'Asia/Tokyo' })
    expect(html).toContain('data-time-zone="Asia/Tokyo"')
    expect(html).toContain('timestamps in Asia/Tokyo')
    // 09:10/10:10 UTC → 18:10/19:10 JST
    expect(html).toContain('2026-07-06 18:10:00 → 2026-07-06 19:10:00 (Asia/Tokyo)')
    expect(html).toContain('<span class="time">2026-07-06 19:01:00</span>')
    // filtering epoch attributes stay timezone-independent
    expect(html).toContain(`data-ts="${Date.parse('2026-07-06T10:01:00.000Z')}"`)
  })

  it('falls back to UTC for an invalid time zone', () => {
    const html = generateReport(fixtureResult(), new Map(), { timeZone: 'Not/AZone' })
    expect(html).toContain('data-time-zone="UTC"')
    expect(html).toContain('(UTC)')
  })
})

describe('renderTimelineSvg', () => {
  it('renders one stacked rect per non-zero status per bucket, plus a hit rect per bucket', () => {
    const svg = renderTimelineSvg(fixtureResult().timeline)
    const rects = svg.match(/<rect /g) ?? []
    // bucket1: hit+error+info (3), bucket2: hit+error+warn (3)
    expect(rects).toHaveLength(6)
    expect(svg.match(/<rect class="hit"/g)).toHaveLength(2)
  })

  it('wraps each bucket in a clickable group with its time range', () => {
    const timeline = fixtureResult().timeline
    const endMs = Date.parse('2026-07-06T10:10:00Z')
    const svg = renderTimelineSvg(timeline, { endMs })
    const from1 = Date.parse(timeline[0].time)
    const from2 = Date.parse(timeline[1].time)
    expect(svg).toContain(`<g class="bucket" data-from="${from1}" data-to="${from2}"`)
    expect(svg).toContain(`<g class="bucket" data-from="${from2}" data-to="${endMs}"`)
  })

  it('falls back to the previous bucket width for the last bucket without endMs', () => {
    const timeline = fixtureResult().timeline
    const svg = renderTimelineSvg(timeline)
    const from2 = Date.parse(timeline[1].time)
    const width = from2 - Date.parse(timeline[0].time)
    expect(svg).toContain(`data-from="${from2}" data-to="${from2 + width}"`)
  })

  it('renders a no-data message for an empty timeline', () => {
    expect(renderTimelineSvg([])).toContain('No data in range')
  })

  it('renders axis labels in the configured time zone (UTC by default)', () => {
    const timeline = fixtureResult().timeline
    expect(renderTimelineSvg(timeline)).toContain('>10:00</text>')
    // 10:00 UTC → 19:00 JST
    expect(renderTimelineSvg(timeline, { timeZone: 'Asia/Tokyo' })).toContain('>19:00</text>')
    expect(renderTimelineSvg(timeline, { timeZone: 'Not/AZone' })).toContain('>10:00</text>')
  })
})

describe('escapeHtml', () => {
  it('escapes all special characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})

describe('cross-source report sections', () => {
  function crossSourceResult(): InvestigationResult {
    return {
      ...fixtureResult(),
      events: [
        {
          id: 'e1',
          time: '2026-07-06T10:03:00.000Z',
          kind: 'deploy',
          title: '<img src=x onerror=alert(1)> deploy',
          source: 'github',
          tags: ['service:payments'],
        },
      ],
      metrics: [
        {
          query: 'avg:system.cpu.user{*}',
          metric: 'avg:system.cpu.user',
          scope: 'service:<b>payments</b>',
          unit: '%',
          points: [
            { time: '2026-07-06T10:00:00.000Z', value: 10 },
            { time: '2026-07-06T10:05:00.000Z', value: null },
            { time: '2026-07-06T10:10:00.000Z', value: 30 },
          ],
          stats: { min: 10, max: 30, avg: 20, last: 30 },
        },
      ],
      notices: ['Events unavailable: <403>'],
    }
  }

  it('renders an escaped events table with kind badges', () => {
    const html = generateReport(crossSourceResult(), new Map())
    expect(html).toContain('Events in window (1)')
    expect(html).toContain('event-badge deploy')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; deploy')
    expect(html).toContain('github')
  })

  it('renders a metrics section with escaped labels, stats, and a sparkline', () => {
    const html = generateReport(crossSourceResult(), new Map())
    expect(html).toContain('<h2>Metrics</h2>')
    expect(html).not.toContain('service:<b>payments</b>')
    expect(html).toContain('service:&lt;b&gt;payments&lt;/b&gt;')
    expect(html).toContain('min 10 · avg 20 · max 30 · last 30 %')
    expect(html).toContain('Metric sparkline')
  })

  it('renders escaped notices and event markers on the timeline SVG', () => {
    const html = generateReport(crossSourceResult(), new Map())
    expect(html).toContain('&lt;403&gt;')
    expect(html).not.toContain('<403>')
    expect(html).toContain('event-marker')
    expect(html).toContain('deploy event')
  })

  it('omits every cross-source section when the fields are absent', () => {
    const html = generateReport(fixtureResult(), new Map())
    expect(html).not.toContain('Events in window')
    expect(html).not.toContain('<h2>Metrics</h2>')
    expect(html).not.toContain('event-marker')
    expect(html).not.toContain('class="notices"')
  })

  it('shows a copyable trace chip on rows that carry a trace id', () => {
    const result = fixtureResult()
    result.rows[0].traceId = 'trace-<script>'
    const html = generateReport(result, new Map())
    expect(html).toContain('trace:trace-&lt;script&gt;')
    expect(html).not.toContain('trace-<script>')
  })
})

describe('renderTimelineSvg event markers', () => {
  const timeline = [
    { time: '2026-07-06T10:00:00.000Z', counts: { error: 5 } },
    { time: '2026-07-06T10:05:00.000Z', counts: { error: 3 } },
  ]

  it('renders a dashed line + triangle per in-range event with an escaped tooltip', () => {
    const svg = renderTimelineSvg(timeline, {
      endMs: Date.parse('2026-07-06T10:10:00Z'),
      events: [{ id: 'e1', time: '2026-07-06T10:05:00.000Z', kind: 'alert', title: '"quoted" & <alert>' }],
    })
    expect(svg).toContain('class="event-marker"')
    expect(svg).toContain('stroke-dasharray="3 3"')
    expect(svg).toContain('var(--event-alert)')
    expect(svg).toContain('&quot;quoted&quot; &amp; &lt;alert&gt;')
  })

  it('drops events outside the rendered bucket range', () => {
    const svg = renderTimelineSvg(timeline, {
      endMs: Date.parse('2026-07-06T10:10:00Z'),
      events: [{ id: 'e1', time: '2026-07-06T12:00:00.000Z', kind: 'deploy', title: 'late deploy' }],
    })
    expect(svg).not.toContain('event-marker')
  })

  it('positions markers by linear interpolation over the bucket span', () => {
    const svg = renderTimelineSvg(timeline, {
      width: 1000,
      endMs: Date.parse('2026-07-06T10:10:00Z'),
      events: [{ id: 'e1', time: '2026-07-06T10:05:00.000Z', kind: 'deploy', title: 'mid deploy' }],
    })
    // Domain 10:00–10:10, event at 10:05 → x = padLeft + plotW / 2 = 44 + 948/2 = 518.
    expect(svg).toContain('x1="518.0"')
  })
})

describe('baseline comparison section', () => {
  function fixtureComparison(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
    return {
      params: { query: 'service:payments', mode: 'shift', shift: '1d', facets: ['service'] },
      target: {
        fromMs: Date.parse('2026-07-06T09:10:00Z'),
        toMs: Date.parse('2026-07-06T10:10:00Z'),
        totalCount: 1234,
        statusCounts: { error: 120, info: 1114 },
        errorRate: 0.0972,
      },
      baseline: {
        fromMs: Date.parse('2026-07-05T09:10:00Z'),
        toMs: Date.parse('2026-07-05T10:10:00Z'),
        totalCount: 600,
        statusCounts: { error: 12, info: 588 },
        errorRate: 0.02,
      },
      interval: '5m',
      volume: {
        total: { targetCount: 1234, baselineCount: 600, delta: 634, ratio: 2.0567 },
        byStatus: [
          { status: 'error', targetCount: 120, baselineCount: 12, delta: 108, ratio: 10 },
          { status: 'info', targetCount: 1114, baselineCount: 588, delta: 526, ratio: 1.894 },
        ],
        errorRateDelta: 0.0772,
      },
      onset: {
        time: '2026-07-06T09:35:00.000Z',
        bucketIndex: 5,
        errorRate: 0.18,
        baselineMean: 0.02,
        baselineStdev: 0.01,
        threshold: 0.05,
        sustainedBuckets: 3,
        sigmas: 16,
        precedingEvent: {
          event: {
            id: 'e9',
            time: '2026-07-06T09:30:00.000Z',
            kind: 'deploy',
            title: 'payments v2.1',
            source: 'github',
          },
          leadTimeMs: 300_000,
        },
      },
      fetchedAt: '2026-07-06T10:10:00.000Z',
      ...overrides,
    }
  }

  function reportWith(overrides: Partial<ComparisonResult> = {}): string {
    return generateReport({ ...fixtureResult(), comparison: fixtureComparison(overrides) }, new Map())
  }

  /** The comparison markup only — the inline CSS mentions the same class names. */
  function comparisonSection(html: string): string {
    const start = html.indexOf('<section class="comparison">')
    if (start === -1) {
      return ''
    }
    return html.slice(start, html.indexOf('</section>', start) + '</section>'.length)
  }

  /** The static report JS legitimately calls isNaN(); everything else must not say NaN. */
  function withoutInlineScript(html: string): string {
    return html.replace(/<script>[\s\S]*<\/script>/, '')
  }

  it('renders no comparison markup at all when the comparison is absent', () => {
    const html = generateReport(fixtureResult(), new Map())
    expect(html).not.toContain('Baseline comparison')
    expect(html).not.toContain('<section class="comparison">')
    expect(comparisonSection(html)).toBe('')
  })

  it('renders the windows, volume and a prominent error rate', () => {
    const html = reportWith()
    const section = comparisonSection(html)
    expect(html).toContain('<h2>Baseline comparison</h2>')
    expect(section).toContain('Baseline: shift 1d · Target 2026-07-06 09:10:00 → 2026-07-06 10:10:00')
    expect(section).toContain('Baseline 2026-07-05 09:10:00 → 2026-07-05 10:10:00')
    expect(section).toContain('buckets 5m')
    // volume and error rate sit side by side: a surge is not an incident on its own
    expect(section).toContain('1,234')
    expect(section).toContain('vs 600 baseline (+634)')
    expect(section).toContain('2.06x')
    expect(section).toContain('Error rate')
    expect(section).toContain('9.7%')
    expect(section).toContain('vs 2.0% baseline')
    expect(section).toContain('+7.7 pts')
    // per-status deltas
    expect(section).toContain('Volume by status')
    expect(section).toContain('<span class="status-badge error">error</span>')
    expect(section).toContain('10.0x')
  })

  it('renders the onset with its threshold arithmetic and preceding event', () => {
    const section = comparisonSection(reportWith())
    expect(section).toContain('Onset 2026-07-06 09:35:00')
    expect(section).toContain('bucket 6/12')
    expect(section).toContain('rate 18.0% vs baseline mean 2.0% ±1.0%')
    expect(section).toContain('threshold 5.0%, 16.0σ')
    expect(section).toContain('sustained 3 buckets')
    expect(section).toContain('preceded by')
    expect(section).toContain('payments v2.1')
    expect(section).toContain('5m before onset')
  })

  it('escapes every log-derived value in the comparison (XSS)', () => {
    const scriptPayload = '<script>alert(1)</script>'
    const attrPayload = '"><img src=x onerror=alert(1)>'
    const html = reportWith({
      params: { query: scriptPayload, scope: attrPayload, mode: 'custom', facets: [scriptPayload] },
      patterns: [
        {
          template: `${scriptPayload} failed for <*>`,
          kind: 'spiking',
          targetRatio: 0.4,
          baselineRatio: 0.1,
          targetSampleCount: 40,
          baselineSampleCount: 10,
          estimatedTargetCount: 400,
          estimatedBaselineCount: 100,
          lift: 4,
          example: attrPayload,
        },
      ],
      facets: [
        {
          facet: scriptPayload,
          values: [
            {
              value: attrPayload,
              targetCount: 90,
              baselineCount: 3,
              targetShare: 0.5,
              baselineShare: 0.01,
              excess: 84,
              lift: 50,
            },
          ],
          targetCovered: 180,
          baselineCovered: 300,
          targetTotal: 200,
          baselineTotal: 320,
        },
      ],
      onset: {
        ...(fixtureComparison().onset ?? {
          time: '2026-07-06T09:35:00.000Z',
          bucketIndex: 5,
          errorRate: 0.18,
          baselineMean: 0.02,
          baselineStdev: 0.01,
          threshold: 0.05,
          sustainedBuckets: 3,
          sigmas: 16,
        }),
        precedingEvent: {
          event: {
            id: 'e9',
            time: '2026-07-06T09:30:00.000Z',
            kind: 'deploy',
            title: scriptPayload,
            source: attrPayload,
          },
          leadTimeMs: 300_000,
        },
      },
      notices: [`Facet ${scriptPayload} was truncated`],
    })
    const section = comparisonSection(html)

    expect(section).not.toContain(scriptPayload)
    expect(section).not.toContain(attrPayload)
    expect(section).not.toContain('<script>alert')
    expect(section).not.toContain('<img src=x')
    expect(section).not.toContain('onerror=alert(1)>')
    expect(section).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(section).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
    // the whole document must not gain an executable payload either
    expect(html).not.toContain('<script>alert(1)')
    expect(html).not.toContain('<img src=x')
  })

  it('keeps a <*> pattern placeholder as escaped text', () => {
    const section = comparisonSection(
      reportWith({
        patterns: [
          {
            template: 'timeout talking to <*> after <*>ms',
            kind: 'new',
            targetRatio: 0.25,
            baselineRatio: 0,
            targetSampleCount: 25,
            baselineSampleCount: 0,
            estimatedTargetCount: 300,
            estimatedBaselineCount: 0,
            lift: null,
            example: 'timeout talking to db after 500ms',
          },
        ],
      })
    )
    expect(section).toContain('timeout talking to &lt;*&gt; after &lt;*&gt;ms')
    expect(section).not.toContain('<*>')
  })

  it('spells out null ratios and lifts instead of Infinity or NaN', () => {
    const html = reportWith({
      volume: {
        total: { targetCount: 1234, baselineCount: 0, delta: 1234, ratio: null },
        byStatus: [{ status: 'error', targetCount: 120, baselineCount: 0, delta: 120, ratio: null }],
        errorRateDelta: 0.0972,
      },
      patterns: [
        {
          template: 'connection reset',
          kind: 'spiking',
          targetRatio: 0.3,
          baselineRatio: 0,
          targetSampleCount: 30,
          baselineSampleCount: 0,
          estimatedTargetCount: 360,
          estimatedBaselineCount: 0,
          lift: null,
          example: 'connection reset',
        },
      ],
      facets: [
        {
          facet: 'service',
          values: [
            {
              value: 'payments',
              targetCount: 90,
              baselineCount: 0,
              targetShare: 0.5,
              baselineShare: 0,
              excess: 90,
              lift: null,
            },
          ],
          targetCovered: 180,
          baselineCovered: 0,
          targetTotal: 200,
          baselineTotal: 0,
        },
      ],
    })
    const section = comparisonSection(html)
    expect(section).toContain('new (baseline 0)')
    expect(section).not.toMatch(/Infinity|NaN/)
    expect(section).not.toContain('null')
    expect(section).not.toContain('undefined')
    expect(withoutInlineScript(html)).not.toMatch(/Infinity|NaN/)
  })

  it('labels a truncated-baseline facet value "rare in baseline", never NEW', () => {
    const section = comparisonSection(
      reportWith({
        facets: [
          {
            facet: 'service',
            values: [
              {
                value: 'checkout',
                targetCount: 90,
                baselineCount: 0,
                targetShare: 0.5,
                baselineShare: 0,
                excess: 90,
                lift: null,
                isNew: true,
                baselineTruncated: true,
              },
            ],
            targetCovered: 180,
            baselineCovered: 300,
            targetTotal: 200,
            baselineTotal: 320,
          },
        ],
      })
    )
    expect(section).toContain('rare in baseline')
    expect(section).not.toContain('NEW')
  })

  it('renders empty pattern and facet arrays exactly like absent fields', () => {
    const absent = comparisonSection(reportWith())
    const empty = comparisonSection(reportWith({ patterns: [], facets: [], notices: [] }))
    expect(empty).toBe(absent)
    expect(empty).not.toContain('Changed message patterns')
    expect(empty).not.toContain('attribution')
  })

  it('renders pattern diffs and facet attribution when present', () => {
    const section = comparisonSection(
      reportWith({
        patterns: [
          {
            template: 'upstream timeout',
            kind: 'spiking',
            targetRatio: 0.4,
            baselineRatio: 0.1,
            targetSampleCount: 40,
            baselineSampleCount: 10,
            estimatedTargetCount: 494,
            estimatedBaselineCount: 60,
            lift: 4,
            example: 'upstream timeout',
          },
        ],
        facets: [
          {
            facet: 'service',
            values: [
              {
                value: 'checkout',
                targetCount: 90,
                baselineCount: 10,
                targetShare: 0.5,
                baselineShare: 0.033,
                excess: 70,
                lift: 15,
                isNew: true,
              },
            ],
            targetCovered: 180,
            baselineCovered: 300,
            targetTotal: 200,
            baselineTotal: 320,
          },
        ],
      })
    )
    expect(section).toContain('Changed message patterns')
    expect(section).toContain('<span class="diff-badge spiking">SPIKING</span>')
    expect(section).toContain('~494')
    expect(section).toContain('~60')
    expect(section).toContain('4.00x')
    expect(section).toContain('<code>upstream timeout</code>')
    expect(section).toContain('service attribution')
    expect(section).toContain('0.60x scale-up')
    expect(section).toContain('checkout')
    expect(section).toContain('+70')
    expect(section).toContain('50.0% vs 3.3%')
    expect(section).toContain('<span class="flag-badge new">NEW</span>')
  })
})
