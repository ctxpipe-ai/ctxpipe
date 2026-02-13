import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import type { Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import { registerMcpTools } from "./tools.js"

export function createMcpRouter() {
  return (app: Hono<AppEnv>) => {
    app.all("/mcp", async (c) => {
      const server = new McpServer({
        name: "ctxpipe-backend",
        version: "0.1.0",
      })
      registerMcpTools(server)
      const transport = new StreamableHTTPTransport()
      await server.connect(transport)
      const res = await transport.handleRequest(c)
      return res ?? new Response(null, { status: 204 })
    })
  }
}
