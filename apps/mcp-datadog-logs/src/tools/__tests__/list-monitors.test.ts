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

  it('quotes tags because monitor tags contain colons, and ANDs them', () => {
    expect(buildMonitorSearchQuery({ state: ['alert'], tags: ['service:web', 'env:prod'] })).toBe(
      'status:Alert tag:"service:web" tag:"env:prod"'
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

    expect(searchMonitors).toHaveBeenCalledWith({
      query: '(status:Alert OR status:Warn OR status:"No Data")',
      perPage: 25,
    })
    const names = result.content[0].text
      .split('\n')
      .slice(1)
      .map((line: string) => line.split(' ')[1])
    expect(names).toEqual(['recent', 'old', 'never'])
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
