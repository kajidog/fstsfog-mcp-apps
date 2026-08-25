import { beforeEach, describe, expect, it, vi } from 'vitest'

const { searchMonitors } = vi.hoisted(() => ({ searchMonitors: vi.fn() }))

vi.mock('../../datadog/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../datadog/client.js')>()),
  getDatadogClient: () => ({ searchMonitors }),
}))

import { createServer } from '../../server.js'
import { buildMonitorSearchQuery, formatMonitorLine } from '../list-monitors.js'

const NOW = Date.parse('2026-08-24T09:26:00Z')

function getTool() {
  return (createServer() as any)._registeredTools.datadog_list_monitors
}

describe('buildMonitorSearchQuery', () => {
  it('defaults to the alerting/warning/no-data states', () => {
    expect(buildMonitorSearchQuery({})).toBe('(status:Alert OR status:Warn OR status:"No Data")')
  })

  it('normalizes state aliases case- and separator-insensitively', () => {
    expect(buildMonitorSearchQuery({ state: ['ALERTING'] })).toBe('status:Alert')
    expect(buildMonitorSearchQuery({ state: ['triggered'] })).toBe('status:Alert')
    expect(buildMonitorSearchQuery({ state: ['Critical'] })).toBe('status:Alert')
    expect(buildMonitorSearchQuery({ state: ['warning'] })).toBe('status:Warn')
    expect(buildMonitorSearchQuery({ state: ['no_data'] })).toBe('status:"No Data"')
    expect(buildMonitorSearchQuery({ state: ['no-data'] })).toBe('status:"No Data"')
    expect(buildMonitorSearchQuery({ state: ['NoData'] })).toBe('status:"No Data"')
    expect(buildMonitorSearchQuery({ state: ['recovered'] })).toBe('status:OK')
  })

  it('ORs multiple states and drops duplicate aliases of the same state', () => {
    expect(buildMonitorSearchQuery({ state: ['alert', 'ok'] })).toBe('(status:Alert OR status:OK)')
    expect(buildMonitorSearchQuery({ state: ['alert', 'alerting', 'critical'] })).toBe('status:Alert')
  })

  it('omits the status clause entirely for "all"', () => {
    expect(buildMonitorSearchQuery({ state: ['all'] })).toBe('')
    expect(buildMonitorSearchQuery({ state: ['all'], tags: ['env:prod'] })).toBe('tag:"env:prod"')
  })

  it('lets "all" widen the query even when other states are listed alongside it', () => {
    expect(buildMonitorSearchQuery({ state: ['all', 'alert'] })).toBe('')
    expect(buildMonitorSearchQuery({ state: ['alert', 'ALL'] })).toBe('')
    expect(buildMonitorSearchQuery({ state: ['warn', 'all'], tags: ['env:prod'] })).toBe('tag:"env:prod"')
  })

  it('quotes tags because monitor tags contain colons, and ANDs them', () => {
    expect(buildMonitorSearchQuery({ state: ['alert'], tags: ['service:web', 'env:prod'] })).toBe(
      'status:Alert tag:"service:web" tag:"env:prod"'
    )
  })

  it('escapes double quotes inside a tag', () => {
    expect(buildMonitorSearchQuery({ state: ['alert'], tags: ['team:"platform ops"'] })).toBe(
      'status:Alert tag:"team:\\"platform ops\\""'
    )
  })

  it('appends name as bare search text', () => {
    expect(buildMonitorSearchQuery({ state: ['alert'], name: 'error rate' })).toBe('status:Alert error rate')
  })
})

describe('formatMonitorLine', () => {
  it('reads lastTriggeredTs as epoch seconds', () => {
    const line = formatMonitorLine(
      {
        id: 12345678,
        name: 'payments error rate high',
        status: 'Alert',
        lastTriggeredTs: Math.floor(Date.parse('2026-08-24T09:12:00Z') / 1000),
        query: 'avg(last_5m):sum:trace.web.request.errors{service:payments}.as_count() > 50',
        tags: ['service:payments', 'env:prod'],
      },
      NOW
    )

    expect(line).toBe(
      [
        '[Alert] payments error rate high (id 12345678) — triggered 14m ago (2026-08-24T09:12:00Z) ' +
          '| tags: service:payments, env:prod',
        '  query: avg(last_5m):sum:trace.web.request.errors{service:payments}.as_count() > 50',
      ].join('\n')
    )
  })

  it('renders hour- and day-scale ages', () => {
    const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
    expect(
      formatMonitorLine({ status: 'Warn', name: 'a', lastTriggeredTs: at('2026-08-24T06:26:00Z') }, NOW)
    ).toContain('triggered 3h ago')
    expect(
      formatMonitorLine({ status: 'Warn', name: 'a', lastTriggeredTs: at('2026-08-22T09:26:00Z') }, NOW)
    ).toContain('triggered 2d ago')
  })

  it('reports monitors that never triggered', () => {
    expect(formatMonitorLine({ id: 7, name: 'idle monitor', status: 'OK' }, NOW)).toBe(
      '[OK] idle monitor (id 7) — never triggered'
    )
  })

  it('reports a null lastTriggeredTs as never triggered', () => {
    const monitor = { id: 7, name: 'idle monitor', status: 'OK', lastTriggeredTs: null as unknown as number }

    expect(formatMonitorLine(monitor, NOW)).toBe('[OK] idle monitor (id 7) — never triggered')
  })

  it('reports a zero lastTriggeredTs as never triggered', () => {
    expect(formatMonitorLine({ id: 7, name: 'idle monitor', status: 'OK', lastTriggeredTs: 0 }, NOW)).toBe(
      '[OK] idle monitor (id 7) — never triggered'
    )
  })

  it('truncates the name at 120 chars and the query at 200 chars', () => {
    const line = formatMonitorLine({ name: 'n'.repeat(200), status: 'Alert', query: 'q'.repeat(300) }, NOW)

    expect(line).toContain(`${'n'.repeat(120)}…`)
    expect(line).not.toContain('n'.repeat(121))
    expect(line).toContain(`  query: ${'q'.repeat(200)}…`)
    expect(line).not.toContain('q'.repeat(201))
  })

  it('caps tags at 8 with a (+N more) suffix', () => {
    const line = formatMonitorLine(
      { name: 'tagged', status: 'Alert', tags: Array.from({ length: 11 }, (_, i) => `tag:${i}`) },
      NOW
    )

    expect(line).toContain('tag:7 (+3 more)')
    expect(line).not.toContain('tag:8')
  })

  it('truncates each tag at 60 chars without changing the (+N more) count', () => {
    const tags = ['a'.repeat(500), ...Array.from({ length: 10 }, (_, i) => `tag:${i}`)]
    const line = formatMonitorLine({ name: 'tagged', status: 'Alert', tags }, NOW)

    expect(line).toContain(`| tags: ${'a'.repeat(60)}…, tag:0`)
    expect(line).not.toContain('a'.repeat(61))
    expect(line).toContain('tag:6 (+3 more)')
    expect(line).not.toContain('tag:7')
  })
})

describe('datadog_list_monitors', () => {
  beforeEach(() => {
    searchMonitors.mockReset()
  })

  it('searches with the built query and renders a header with the total count', async () => {
    searchMonitors.mockResolvedValue({
      monitors: [{ id: 1, name: 'web 5xx', status: 'Alert', tags: ['service:web'] }],
      totalCount: 42,
    })

    const result = await getTool().handler({ tags: ['service:web'], limit: 25, sort: 'status' })

    expect(searchMonitors).toHaveBeenCalledWith({
      query: '(status:Alert OR status:Warn OR status:"No Data") tag:"service:web"',
      perPage: 25,
      sort: 'status,asc',
    })
    expect(result.content[0].text.split('\n')[0]).toBe(
      '1 of ~42 monitors (query: (status:Alert OR status:Warn OR status:"No Data") tag:"service:web")'
    )
  })

  it('passes a raw query through untouched and ignores state/tags/name', async () => {
    searchMonitors.mockResolvedValue({ monitors: [{ id: 1, name: 'm', status: 'Alert' }] })

    const result = await getTool().handler({
      query: 'type:log status:Alert',
      state: ['ok'],
      tags: ['env:prod'],
      name: 'ignored',
      limit: 10,
      sort: 'name',
    })

    expect(searchMonitors).toHaveBeenCalledWith({ query: 'type:log status:Alert', perPage: 10, sort: 'name,asc' })
    expect(result.content[0].text.split('\n')[0]).toBe('1 monitors (query: type:log status:Alert)')
  })

  it('sorts last_triggered client-side and sends no API sort key', async () => {
    const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
    searchMonitors.mockResolvedValue({
      monitors: [
        { id: 1, name: 'old', status: 'Alert', lastTriggeredTs: at('2026-08-20T09:00:00Z') },
        { id: 2, name: 'never', status: 'Alert' },
        { id: 3, name: 'recent', status: 'Alert', lastTriggeredTs: at('2026-08-24T09:00:00Z') },
      ],
    })

    const result = await getTool().handler({ limit: 25, sort: 'last_triggered' })

    // last_triggered over-fetches a full page: client-side sorting can only order what was fetched.
    expect(searchMonitors).toHaveBeenCalledWith({
      query: '(status:Alert OR status:Warn OR status:"No Data")',
      perPage: 100,
    })
    const names = result.content[0].text
      .split('\n')
      .slice(1)
      .map((line: string) => line.split(' ')[1])
    expect(names).toEqual(['recent', 'old', 'never'])
  })

  it('treats undefined, null and zero lastTriggeredTs alike when sorting by last trigger', async () => {
    const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
    searchMonitors.mockResolvedValue({
      monitors: [
        { id: 1, name: 'never-undefined', status: 'Alert' },
        { id: 2, name: 'older', status: 'Alert', lastTriggeredTs: at('2026-08-20T09:00:00Z') },
        { id: 3, name: 'never-null', status: 'Alert', lastTriggeredTs: null },
        { id: 4, name: 'newest', status: 'Alert', lastTriggeredTs: at('2026-08-24T09:00:00Z') },
        { id: 5, name: 'never-zero', status: 'Alert', lastTriggeredTs: 0 },
      ],
    })

    const result = await getTool().handler({ limit: 25, sort: 'last_triggered' })
    const lines: string[] = result.content[0].text.split('\n').slice(1)

    expect(lines.map((line) => line.split(' ')[1])).toEqual([
      'newest',
      'older',
      'never-undefined',
      'never-null',
      'never-zero',
    ])
    expect(lines.slice(2).every((line) => line.includes('never triggered'))).toBe(true)
  })

  it('over-fetches so the newest monitor survives a limit smaller than the match set', async () => {
    const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
    const monitors: Record<string, unknown>[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      name: `m${i}`,
      status: 'Alert',
      lastTriggeredTs: at('2026-08-20T09:00:00Z') + i,
    }))
    // The genuinely newest monitor sits late in the page Datadog returned.
    monitors[8] = { id: 9, name: 'newest', status: 'Alert', lastTriggeredTs: at('2026-08-24T09:00:00Z') }
    searchMonitors.mockResolvedValue({ monitors, totalCount: 60 })

    const result = await getTool().handler({ limit: 3, sort: 'last_triggered' })
    const lines: string[] = result.content[0].text.split('\n')

    expect(searchMonitors).toHaveBeenCalledWith({
      query: '(status:Alert OR status:Warn OR status:"No Data")',
      perPage: 100,
    })
    expect(lines[0]).toBe('3 of ~60 monitors (query: (status:Alert OR status:Warn OR status:"No Data"))')
    expect(lines[1]).toContain('newest')
    expect(lines.slice(1, 4).map((line) => line.split(' ')[1])).toEqual(['newest', 'm9', 'm7'])
    expect(lines).toHaveLength(5)
  })

  it('discloses that the last-trigger ordering only covers the fetched page', async () => {
    searchMonitors.mockResolvedValue({
      monitors: [
        { id: 1, name: 'a', status: 'Alert' },
        { id: 2, name: 'b', status: 'Alert' },
      ],
      totalCount: 60,
    })

    const result = await getTool().handler({ limit: 25, sort: 'last_triggered' })

    expect(result.content[0].text).toContain(
      '(sorted by last trigger within the first 2 matches only; narrow with tags/name for an exact ranking)'
    )
  })

  it('omits the partial-sort note when the page holds every match', async () => {
    searchMonitors.mockResolvedValue({ monitors: [{ id: 1, name: 'a', status: 'Alert' }], totalCount: 1 })

    const result = await getTool().handler({ limit: 25, sort: 'last_triggered' })

    expect(result.content[0].text).not.toContain('sorted by last trigger')
  })

  it('omits the partial-sort note when the total count is unknown or the sort is server-side', async () => {
    searchMonitors.mockResolvedValue({ monitors: [{ id: 1, name: 'a', status: 'Alert' }] })
    const unknownTotal = await getTool().handler({ limit: 25, sort: 'last_triggered' })
    expect(unknownTotal.content[0].text).not.toContain('sorted by last trigger')

    searchMonitors.mockResolvedValue({ monitors: [{ id: 1, name: 'a', status: 'Alert' }], totalCount: 60 })
    const statusSorted = await getTool().handler({ limit: 25, sort: 'status' })
    expect(statusSorted.content[0].text).not.toContain('sorted by last trigger')
  })

  it('displays an empty query as * in the header', async () => {
    searchMonitors.mockResolvedValue({ monitors: [{ id: 1, name: 'a', status: 'OK' }], totalCount: 1 })

    const result = await getTool().handler({ state: ['all'], limit: 25, sort: 'status' })

    expect(searchMonitors).toHaveBeenCalledWith({ query: '', perPage: 25, sort: 'status,asc' })
    expect(result.content[0].text.split('\n')[0]).toBe('1 of ~1 monitors (query: *)')
  })

  it('displays an empty query as * in the zero-match message', async () => {
    searchMonitors.mockResolvedValue({ monitors: [] })

    const result = await getTool().handler({ state: ['all'], limit: 25, sort: 'status' })

    expect(result.content[0].text).toBe('No monitors matched query "*".')
  })

  it('reports when no monitors matched', async () => {
    searchMonitors.mockResolvedValue({ monitors: [] })

    const result = await getTool().handler({ state: ['alert'], limit: 25, sort: 'status' })

    expect(result.content[0].text).toBe('No monitors matched query "status:Alert".')
  })

  it('names the monitors_read scope on 403 responses', async () => {
    searchMonitors.mockRejectedValue({ code: 403, message: 'Forbidden' })

    const result = await getTool().handler({ limit: 25, sort: 'status' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('monitors_read')
    expect(result.content[0].text).not.toContain('logs_read_data')
  })
})
