import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import {
  requireAuth,
  withCookieAuth,
  withMcpBearerAuth,
  withNetworkOrgContext,
  withOrgApiKeyAuth,
} from "../auth/withAuth.js"
import { registerMcpTools } from "../mcp/tools.js"
import {
  handleMcpTransportRequest,
  type McpTransportOptions,
  rejectInvalidMcpOrigin,
} from "../mcp/transport.js"

/**
 * `/mcp` with the production auth chain. The tool set and the instructions
 * are parameters so that a test can mount the framework tools; the defaults
 * are the tools that ship.
 */
export function registerMcpRoutes(
  app: Hono<AppEnv>,
  {
    registerTools = registerMcpTools,
    ...transportOptions
  }: McpTransportOptions & {
    registerTools?: (server: McpServer) => void
  } = {},
) {
  app.all(
    "/mcp",
    (c, next) => rejectInvalidMcpOrigin(c) ?? next(),
    withMcpBearerAuth,
    withCookieAuth,
    withOrgApiKeyAuth,
    requireAuth,
    withNetworkOrgContext,
    (c) => handleMcpTransportRequest(c, registerTools, transportOptions),
  )
}
