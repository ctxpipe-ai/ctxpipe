import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono, MiddlewareHandler } from "hono"
import type { AppEnv } from "../app/env.js"
import { callPrincipalFromContext, resolveCallOrg } from "../auth/call-org.js"
import {
  bindRequestOrg,
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
 * Default org of an MCP request (ADR-051 §3). Read tools name their org in
 * the `org` argument and ignore this default; `?orgSlug=` is accepted and has
 * no effect on them. The default is the `?orgSlug=` org when the principal
 * can use it, else the only allowed org, else none. No case gives an error
 * here. The call, not this middleware, sets the org attribution.
 */
const withMcpDefaultOrg: MiddlewareHandler<AppEnv> = async (c, next) => {
  const principal = callPrincipalFromContext(c)
  const slug = c.req.query("orgSlug")?.trim() || undefined
  let result = await resolveCallOrg(principal, slug)
  if (!result.ok && slug) result = await resolveCallOrg(principal, undefined)
  if (!result.ok) return next()
  return bindRequestOrg(c, result.org, next, { attribute: false })
}

/**
 * `/mcp` with the production auth chain. The tool set and the instructions
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
    withMcpDefaultOrg,
    (c) => handleMcpTransportRequest(c, registerTools, { instructions }),
  )
}
