import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComparisonResult } from '@kajidog/investigation-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InvestigationSession } from '../investigate/runtime.js'
import { clearSessions, getSession, setSession } from '../investigate/runtime.js'
import { fixtureRawById, fixtureResult } from './fixtures.js'

const VIEW_UUID = '11111111-2222-3333-4444-555555555555'
const OTHER_UUID = '99999999-8888-7777-6666-555555555555'

function fixtureComparison(): ComparisonResult {
  const window = (fromMs: number, totalCount: number, errorRate: number) => ({
    fromMs,
    toMs: fromMs + 3_600_000,
    totalCount,
    statusCounts: { error: Math.round(totalCount * errorRate) },
    errorRate,
  })
  return {
    params: { query: 'service:payments status:error', mode: 'previous', facets: ['service'] },
    target: window(Date.parse('2026-07-06T09:10:00Z'), 1234, 0.1),
    baseline: window(Date.parse('2026-07-06T08:10:00Z'), 600, 0.02),
    interval: '5m',
    volume: {
      total: { targetCount: 1234, baselineCount: 600, delta: 634, ratio: 2.06 },
      byStatus: [{ status: 'error', targetCount: 123, baselineCount: 12, delta: 111, ratio: 10.25 }],
      errorRateDelta: 0.08,
    },
    fetchedAt: '2026-07-06T10:10:00.000Z',
  }
}

function fixtureSession(result = fixtureResult()): InvestigationSession {
  return {
    result,
    rawById: fixtureRawById(result),
    title: 'Persisted',
    findings: 'root cause note',
    createdAt: 1,
    updatedAt: 2,
  }
}

let dir: string

beforeEach(() => {
  clearSessions()
  dir = mkdtempSync(join(tmpdir(), 'dd-sessions-'))
  vi.stubEnv('MCP_DATADOG_SESSION_DIR', dir)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('session persistence', () => {
  it('restores a session from disk after the in-memory store is cleared', () => {
    setSession(VIEW_UUID, fixtureSession())
    clearSessions()

    const restored = getSession(VIEW_UUID)
    expect(restored).toBeDefined()
    expect(restored?.title).toBe('Persisted')
    expect(restored?.findings).toBe('root cause note')
    expect(restored?.result.rows.map((r) => r.id)).toEqual(['log-1', 'log-2', 'log-3', 'log-4'])
    // rawById round-trips through the flattened rawLogs array
    expect(restored?.rawById.get('log-2')).toEqual({ id: 'log-2' })
  })

  it('round-trips a session carrying a baseline comparison', () => {
    const comparison = fixtureComparison()
    setSession(VIEW_UUID, fixtureSession(fixtureResult({ comparison })))
    clearSessions()

    const restored = getSession(VIEW_UUID)
    expect(restored?.result.comparison).toEqual(comparison)
  })

  it('loads version-1 files written before the cross-source fields existed', () => {
    setSession(VIEW_UUID, fixtureSession(fixtureResult({ comparison: fixtureComparison() })))
    const path = join(dir, `${VIEW_UUID}.json`)
    const file = JSON.parse(readFileSync(path, 'utf-8'))
    // The schema version does not move for optional fields: a file written
    // before they existed is still version 1 and must load unchanged.
    expect(file.version).toBe(1)
    // Simulate a pre-cross-source file: strip the optional fields entirely.
    const { events: _e, metrics: _m, traceCandidates: _t, notices: _n, comparison: _c, ...legacyResult } = file.result
    writeFileSync(path, JSON.stringify({ ...file, result: legacyResult }), 'utf-8')
    clearSessions()

    const restored = getSession(VIEW_UUID)
    expect(restored).toBeDefined()
    expect(restored?.result.events).toBeUndefined()
    expect(restored?.result.metrics).toBeUndefined()
    expect(restored?.result.traceCandidates).toBeUndefined()
    expect(restored?.result.notices).toBeUndefined()
    // The key itself must be absent, not present-and-undefined.
    expect('comparison' in (restored?.result ?? {})).toBe(false)
    expect(restored?.result.rows.map((r) => r.id)).toEqual(['log-1', 'log-2', 'log-3', 'log-4'])
  })

  it('returns undefined for corrupt files and schema version mismatches', () => {
    writeFileSync(join(dir, `${VIEW_UUID}.json`), 'not json{', 'utf-8')
    expect(getSession(VIEW_UUID)).toBeUndefined()

    setSession(OTHER_UUID, fixtureSession())
    const path = join(dir, `${OTHER_UUID}.json`)
    const file = JSON.parse(readFileSync(path, 'utf-8'))
    writeFileSync(path, JSON.stringify({ ...file, version: 999 }), 'utf-8')
    clearSessions()
    expect(getSession(OTHER_UUID)).toBeUndefined()
  })

  it('does nothing when persistence is disabled', () => {
    vi.stubEnv('MCP_DATADOG_PERSIST_SESSIONS', 'false')
    setSession(VIEW_UUID, fixtureSession())
    expect(readdirSync(dir)).toEqual([])
    clearSessions()
    expect(getSession(VIEW_UUID)).toBeUndefined()
  })

  it('survives an unwritable session directory without throwing', () => {
    vi.stubEnv('MCP_DATADOG_SESSION_DIR', join(dir, 'file-in-the-way'))
    writeFileSync(join(dir, 'file-in-the-way'), '', 'utf-8')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => setSession(VIEW_UUID, fixtureSession())).not.toThrow()
    } finally {
      errorSpy.mockRestore()
    }
    // Still served from memory even though the disk mirror failed.
    expect(getSession(VIEW_UUID)).toBeDefined()
  })

  it('prunes files older than the TTL on write', () => {
    setSession(VIEW_UUID, fixtureSession())
    const stalePath = join(dir, `${VIEW_UUID}.json`)
    const staleTime = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(stalePath, staleTime, staleTime)

    setSession(OTHER_UUID, fixtureSession())
    const names = readdirSync(dir)
    expect(names).toContain(`${OTHER_UUID}.json`)
    expect(names).not.toContain(`${VIEW_UUID}.json`)
  })

  it('ignores viewUUIDs that are not plain uuid file names', () => {
    expect(getSession('../escape')).toBeUndefined()
  })

  it('never writes a file for a non-UUID session id (path traversal guard)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => setSession('../../escape', fixtureSession())).not.toThrow()
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('non-UUID'))
    } finally {
      errorSpy.mockRestore()
    }
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(join(dir, '..', '..', 'escape.json'))).toBe(false)
    expect(existsSync(join(dir, '..', '..', 'escape.json.tmp'))).toBe(false)
  })
})
