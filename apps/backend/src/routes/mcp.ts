import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"

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
    // The tools take short queries and refs (a few KB at most), so this only
    // stops a body that would exhaust memory (GHSA-f897-62hf-6gxq). 4 MiB is
    // the MCP SDK transport's own default; `@hono/mcp` reads the body itself,
    // so the route sets the limit.
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: (c) => c.json({ error: "Payload too large" }, 413),
    }),
    withMcpBearerAuth,
    withCookieAuth,
    withOrgApiKeyAuth,
    requireAuth,
    (c) => handleMcpTransportRequest(c, registerTools, { instructions }),
  )
}
