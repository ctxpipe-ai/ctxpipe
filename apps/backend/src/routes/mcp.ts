import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import {
  requireAuth,
  withBearerAuth,
  withOrgContext,
} from "../auth/withAuth.js"
import { registerMcpTools } from "../mcp/tools.js"

export function registerMcpRoutes(app: Hono<AppEnv>) {
  app.all(
    "/mcp",
    (c, next) => {
      if (c.req.query("orgSlug")) return next()
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message:
              "Missing required orgSlug query parameter. Use /mcp?orgSlug=<orgSlug>.",
          },
          id: null,
        },
        400,
      )
    },
    withBearerAuth,
    requireAuth,
    withOrgContext,
    async (c) => {
      const server = new McpServer({
        name: "ctxpipe",
        version: "0.1.0",
      })
      registerMcpTools(server)
      const transport = new StreamableHTTPTransport()
      await server.connect(transport)
      const res = await transport.handleRequest(c)
      return res ?? new Response(null, { status: 204 })
    },
  )
}
