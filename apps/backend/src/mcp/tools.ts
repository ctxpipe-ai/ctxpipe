import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

/**
 * Register MCP tools. Tools should call into domain/ services so REST and MCP
 * share the same business logic.
 */
export function registerMcpTools(server: McpServer): void {
  server.tool("ping", "Simple ping tool for connectivity check", {}, async () => ({
    content: [{ type: "text", text: "pong" }],
  }))
}
