import { describe, expect, it } from 'vitest'
import { createServer } from '../../server.js'
import { addToolPrefix } from '../registration.js'

describe('addToolPrefix', () => {
  it('prefixes public tools', () => {
    expect(addToolPrefix('search_logs')).toBe('datadog_search_logs')
  })

  it('leaves app-only tools unprefixed', () => {
    expect(addToolPrefix('_get_view_state')).toBe('_get_view_state')
  })
})

describe('createServer tool registration', () => {
  it('registers the expected tools with correct visibility', () => {
    const server = createServer()
    const tools = (server as any)._registeredTools as Record<string, { _meta?: { ui?: any } }>
    const names = Object.keys(tools)

    expect(names).toEqual(
      expect.arrayContaining([
        'datadog_search_logs',
        'datadog_aggregate_logs',
        'datadog_get_trace',
        'datadog_search_events',
        'datadog_query_metrics',
        'datadog_list_monitors',
        'datadog_compare_windows',
        'datadog_run_investigation',
        'datadog_get_session_logs',
        'datadog_export_report',
        'datadog_investigate_logs',
        '_get_view_state',
        '_run_investigation',
        '_get_log_detail',
        '_export_report',
      ])
    )

    // investigate tool opens the UI
    expect(tools.datadog_investigate_logs._meta?.ui?.resourceUri).toBe('ui://datadog-logs/investigator.html')
    // app-only tools are hidden from the model
    for (const name of ['_get_view_state', '_run_investigation', '_get_log_detail', '_export_report']) {
      expect(tools[name]._meta?.ui?.visibility, name).toEqual(['app'])
    }
    // model-facing search tools do not open the UI
    expect(tools.datadog_search_logs._meta?.ui?.resourceUri).toBeUndefined()
    // trace/event correlation tools are model-facing and must not open the UI
    expect(tools.datadog_get_trace._meta?.ui).toBeUndefined()
    expect(tools.datadog_search_events._meta?.ui).toBeUndefined()
    // metric/monitor correlation tools are model-facing and must not open the UI
    expect(tools.datadog_query_metrics._meta?.ui).toBeUndefined()
    expect(tools.datadog_list_monitors._meta?.ui).toBeUndefined()
    // baseline comparison is model-facing and must not open the UI
    expect(tools.datadog_compare_windows._meta?.ui).toBeUndefined()
    // headless investigation tool is model-facing and must not open the UI
    expect(tools.datadog_run_investigation._meta?.ui).toBeUndefined()
    // session drill-down tool is model-facing and must not open the UI
    expect(tools.datadog_get_session_logs._meta?.ui).toBeUndefined()
    // report export tool is model-facing and must not open the UI
    expect(tools.datadog_export_report._meta?.ui).toBeUndefined()
  })
})
