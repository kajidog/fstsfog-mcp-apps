import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAggregateLogsTool } from './tools/aggregate-logs.js'
import { registerCompareWindowsTool } from './tools/compare-windows.js'
import { registerGetTraceTool } from './tools/get-trace.js'
import { registerInvestigateAppTools } from './tools/investigate/app-tools.js'
import { registerExportReportTool } from './tools/investigate/export-report-tool.js'
import { registerGetSessionLogsTool } from './tools/investigate/get-session-logs-tool.js'
import { registerInvestigateTool } from './tools/investigate/investigate-tool.js'
import { registerInvestigatorResource } from './tools/investigate/resource.js'
import { registerRunInvestigationTool } from './tools/investigate/run-investigation-tool.js'
import { registerListMonitorsTool } from './tools/list-monitors.js'
import { registerQueryMetricsTool } from './tools/query-metrics.js'
import { registerSearchEventsTool } from './tools/search-events.js'
import { registerSearchLogsTool } from './tools/search-logs.js'
import { VERSION } from './version.js'

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-datadog-logs',
    version: VERSION,
    description: 'Investigate Datadog logs with an interactive MCP Apps UI and shareable HTML reports',
  })

  registerInvestigatorResource(server)
  registerSearchLogsTool(server)
  registerAggregateLogsTool(server)
  registerGetTraceTool(server)
  registerSearchEventsTool(server)
  registerQueryMetricsTool(server)
  registerListMonitorsTool(server)
  registerCompareWindowsTool(server)
  registerRunInvestigationTool(server)
  registerGetSessionLogsTool(server)
  registerExportReportTool(server)
  registerInvestigateTool(server)
  registerInvestigateAppTools(server)

  return server
}
