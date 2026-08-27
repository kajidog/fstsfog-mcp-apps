import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VIEW_UUID_PATTERN } from '@kajidog/investigation-shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInvestigation } from '../../datadog/investigation.js'
import { createServer } from '../../server.js'
import { clearSessions, getSession, setSession } from '../investigate/runtime.js'
import { fixtureRawById, fixtureResult } from './fixtures.js'

vi.mock('../../datadog/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../datadog/client.js')>()),
  getDatadogClient: vi.fn(() => ({})),
}))
vi.mock('../../datadog/investigation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../datadog/investigation.js')>()),
  runInvestigation: vi.fn(),
}))
// Exporting a report tries to open a browser — never spawn one from tests.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('spawn disabled in tests')
  }),
}))

const runInvestigationMock = vi.mocked(runInvestigation)
const VIEW_UUID = '11111111-2222-3333-4444-555555555555'

function getHandler(name: string) {
  const server = createServer()
  const tools = (server as any)._registeredTools as Record<string, { handler: (args: any, extra: any) => any }>
  return (args: Record<string, unknown>) => tools[name].handler(args, {})
}

function seedSession(findings?: string): void {
  const result = fixtureResult()
  setSession(VIEW_UUID, {
    result,
    rawById: fixtureRawById(result),
    title: 'Seeded',
    findings,
    createdAt: 1,
    updatedAt: 1,
  })
}

function resultText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? '').join('\n')
}

beforeEach(() => {
  clearSessions()
  runInvestigationMock.mockReset()
  vi.unstubAllEnvs()
  // Fresh dir per test so sessions persisted by one test never leak into the
  // "missing session" cases of another.
  vi.stubEnv('MCP_DATADOG_SESSION_DIR', mkdtempSync(join(tmpdir(), 'dd-sessions-')))
})

describe('datadog_investigate_logs with viewUUID', () => {
  it('displays an existing session without calling Datadog', async () => {
    seedSession('root cause note')
    const call = getHandler('datadog_investigate_logs')
    const res = await call({ query: '*', from: 'now-1h', to: 'now', viewUUID: VIEW_UUID })

    expect(res.isError).toBeUndefined()
    const text = resultText(res)
    expect(text.match(new RegExp(VIEW_UUID_PATTERN))?.[1]).toBe(VIEW_UUID)
    expect(runInvestigationMock).not.toHaveBeenCalled()
  })

  it('updates findings on the stored session when provided', async () => {
    seedSession('old note')
    const call = getHandler('datadog_investigate_logs')
    await call({ query: '*', from: 'now-1h', to: 'now', viewUUID: VIEW_UUID, findings: 'new note' })
    expect(getSession(VIEW_UUID)?.findings).toBe('new note')
  })

  it('returns isError for a missing/expired session instead of re-fetching', async () => {
    const call = getHandler('datadog_investigate_logs')
    const res = await call({ query: '*', from: 'now-1h', to: 'now', viewUUID: VIEW_UUID })
    expect(res.isError).toBe(true)
    expect(resultText(res)).toContain('not found')
    expect(runInvestigationMock).not.toHaveBeenCalled()
  })
})

describe('datadog_run_investigation', () => {
  it('stores the full result and returns only a compact summary with a viewUUID', async () => {
    const result = fixtureResult()
    runInvestigationMock.mockResolvedValueOnce({ result, rawById: fixtureRawById(result) })

    const call = getHandler('datadog_run_investigation')
    const res = await call({ query: 'status:error', from: 'now-1h', to: 'now', sampleRows: 2 })

    const text = resultText(res)
    const uuid = text.match(new RegExp(VIEW_UUID_PATTERN))?.[1]
    expect(uuid).toBeDefined()
    expect(getSession(uuid as string)?.result.rows).toHaveLength(4)
    expect(text).toContain('Sample logs (2 of 4 stored, errors first):')
    expect(text).toContain('datadog_get_session_logs')
    expect(text).toContain('datadog_investigate_logs')
    // compact: the summary must not inline all stored rows
    expect(text).not.toContain('log-3')
  })

  it('rejects cursor without viewUUID', async () => {
    const call = getHandler('datadog_run_investigation')
    const res = await call({ query: '*', from: 'now-1h', to: 'now', sampleRows: 3, cursor: 'page-2' })
    expect(res.isError).toBe(true)
    expect(runInvestigationMock).not.toHaveBeenCalled()
  })

  it('passes the baseline params through to the investigation', async () => {
    const result = fixtureResult()
    runInvestigationMock.mockResolvedValueOnce({ result, rawById: fixtureRawById(result) })

    const call = getHandler('datadog_run_investigation')
    await call({
      query: 'status:error',
      from: 'now-1h',
      to: 'now',
      sampleRows: 0,
      baseline: '1d',
      baselineFrom: 'now-2d',
      baselineTo: 'now-1d',
    })

    expect(runInvestigationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ baseline: '1d', baselineFrom: 'now-2d', baselineTo: 'now-1d' })
    )
  })

  it('inherits the baseline params from the stored session when a re-run omits them', async () => {
    const storedResult = fixtureResult({
      params: {
        query: 'service:payments status:error',
        from: 'now-1h',
        to: 'now',
        baseline: '1w',
        baselineFrom: 'now-8d',
        baselineTo: 'now-7d',
      },
    })
    setSession(VIEW_UUID, {
      result: storedResult,
      rawById: fixtureRawById(storedResult),
      createdAt: 1,
      updatedAt: 1,
    })
    const result = fixtureResult()
    runInvestigationMock.mockResolvedValueOnce({ result, rawById: fixtureRawById(result) })

    const call = getHandler('datadog_run_investigation')
    await call({ viewUUID: VIEW_UUID, query: 'service:payments', from: 'now-2h', to: 'now', sampleRows: 0 })

    expect(runInvestigationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ baseline: '1w', baselineFrom: 'now-8d', baselineTo: 'now-7d' })
    )
  })

  it('carries a previous comparison forward on a cursor continuation', async () => {
    const comparison = {
      params: { query: 'service:payments status:error', mode: 'previous' as const, facets: ['service'] },
      target: { fromMs: 1, toMs: 2, totalCount: 10, statusCounts: { error: 5 }, errorRate: 0.5 },
      baseline: { fromMs: 0, toMs: 1, totalCount: 4, statusCounts: { error: 1 }, errorRate: 0.25 },
      interval: '5m',
      volume: {
        total: { targetCount: 10, baselineCount: 4, delta: 6, ratio: 2.5 },
        byStatus: [],
        errorRateDelta: 0.25,
      },
      fetchedAt: '2026-07-06T10:10:00.000Z',
    }
    const storedResult = fixtureResult({ comparison })
    setSession(VIEW_UUID, {
      result: storedResult,
      rawById: fixtureRawById(storedResult),
      createdAt: 1,
      updatedAt: 1,
    })
    // A load-more page never re-runs the comparison, so its result carries none.
    const page = fixtureResult()
    runInvestigationMock.mockResolvedValueOnce({ result: page, rawById: fixtureRawById(page) })

    const call = getHandler('datadog_run_investigation')
    await call({ viewUUID: VIEW_UUID, cursor: 'page-2' })

    expect(getSession(VIEW_UUID)?.result.comparison).toEqual(comparison)
  })

  it('does not inject the new-investigation defaults into a cursor continuation', async () => {
    const storedResult = fixtureResult({
      params: { query: 'service:payments status:error', from: 'now-7d', to: 'now' },
    })
    setSession(VIEW_UUID, {
      result: storedResult,
      rawById: fixtureRawById(storedResult),
      createdAt: 1,
      updatedAt: 1,
    })
    const result = fixtureResult({
      params: { query: 'service:payments status:error', from: 'now-7d', to: 'now', cursor: 'page-2' },
    })
    runInvestigationMock.mockResolvedValueOnce({ result, rawById: fixtureRawById(result) })

    const call = getHandler('datadog_run_investigation')
    await call({ viewUUID: VIEW_UUID, cursor: 'page-2' })

    expect(runInvestigationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        query: 'service:payments status:error',
        from: '2026-07-06T09:10:00.000Z',
        to: '2026-07-06T10:10:00.000Z',
        cursor: 'page-2',
      })
    )
  })
})

describe('datadog_export_report', () => {
  it('writes an HTML report for a stored session and returns the saved path', async () => {
    seedSession('root cause note')
    const dir = mkdtempSync(join(tmpdir(), 'dd-report-'))
    vi.stubEnv('MCP_DATADOG_EXPORT_DIR', dir)
    vi.stubEnv('MCP_DATADOG_TIMEZONE', 'Asia/Tokyo')

    const call = getHandler('datadog_export_report')
    const res = await call({ viewUUID: VIEW_UUID })

    expect(res.isError).toBeUndefined()
    const text = resultText(res)
    const path = text.match(/Report saved to (\S+\.html)/)?.[1]
    expect(path).toBeDefined()
    expect(path).toContain(dir)
    const html = readFileSync(path as string, 'utf-8')
    expect(html).toContain('root cause note')
    expect(html).toContain('data-time-zone="Asia/Tokyo"')
    expect(runInvestigationMock).not.toHaveBeenCalled()
  })

  it('returns isError for a missing/expired session', async () => {
    const call = getHandler('datadog_export_report')
    const res = await call({ viewUUID: VIEW_UUID })
    expect(res.isError).toBe(true)
    expect(resultText(res)).toContain('not found')
  })

  it('writes CSV/JSON data exports without opening a browser', async () => {
    seedSession()
    const dir = mkdtempSync(join(tmpdir(), 'dd-report-'))
    vi.stubEnv('MCP_DATADOG_EXPORT_DIR', dir)
    const call = getHandler('datadog_export_report')

    const csvRes = await call({ viewUUID: VIEW_UUID, format: 'csv' })
    expect(csvRes.isError).toBeUndefined()
    const csvPath = resultText(csvRes).match(/Report saved to (\S+\.csv)/)?.[1]
    expect(csvPath).toBeDefined()
    const csv = readFileSync(csvPath as string, 'utf-8')
    expect(csv).toContain('id,timestamp,status,service,host,message,tags')
    expect(csv).toContain('log-1')

    const jsonRes = await call({ viewUUID: VIEW_UUID, format: 'json' })
    const jsonPath = resultText(jsonRes).match(/Report saved to (\S+\.json)/)?.[1]
    const parsed = JSON.parse(readFileSync(jsonPath as string, 'utf-8'))
    expect(parsed.meta.rowCount).toBe(4)
    expect(parsed.rows).toHaveLength(4)
  })
})

describe('_export_report (app)', () => {
  it('exports only the requested rowIds for data formats', async () => {
    seedSession()
    const dir = mkdtempSync(join(tmpdir(), 'dd-report-'))
    vi.stubEnv('MCP_DATADOG_EXPORT_DIR', dir)

    const call = getHandler('_export_report')
    const res = await call({ viewUUID: VIEW_UUID, format: 'csv', rowIds: ['log-2', 'log-3'] })
    expect(res.isError).toBeUndefined()
    const exported = JSON.parse(resultText(res))
    expect(exported.ok).toBe(true)
    expect(exported.opened).toBe(false)
    const csv = readFileSync(exported.path, 'utf-8')
    expect(csv).toContain('log-2')
    expect(csv).toContain('log-3')
    expect(csv).not.toContain('log-1')
  })
})
