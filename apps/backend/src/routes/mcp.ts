import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono } from "hono"

import type { AppEnv } from "../app/env.js"
import {
  requireAuth,
  withCookieAuth,
  withMcpBearerAuth,
  withOrgApiKeyAuth,
} from "../auth/withAuth.js"
import { loadServerInstructions } from "../mcp/framework/instructions.js"
import { registerMcpTools } from "../mcp/tools.js"
import {
  handleMcpTransportRequest,
  type McpTransportOptions,
  rejectInvalidMcpOrigin,
} from "../mcp/transport.js"

/**
 * `/mcp` with the production auth chain. Read tools name their org in the
 * `org` argument (ADR-051 §3); a `?orgSlug=` query is accepted and ignored. The tool set and the instructions
 * are parameters so that a test can mount the framework tools; the defaults
 * are the tools, the resource template, and the instructions that ship.
 */
export function registerMcpRoutes(
  app: Hono<AppEnv>,
  {
    registerTools = registerMcpTools,
    instructions = loadServerInstructions,
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
    (c) => handleMcpTransportRequest(c, registerTools, { instructions }),
  )
}
