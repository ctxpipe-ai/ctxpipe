import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono, MiddlewareHandler } from "hono"
import type { AppEnv } from "../app/env.js"
import { callPrincipalFromContext, resolveCallOrg } from "../auth/call-org.js"
import {
  requireAuth,
  withCookieAuth,
  withMcpBearerAuth,
  withOrgApiKeyAuth,
  withOrgIdContext,
} from "../auth/withAuth.js"
import { registerMcpTools } from "../mcp/tools.js"
import {
  handleMcpTransportRequest,
  type McpTransportOptions,
  rejectInvalidMcpOrigin,
} from "../mcp/transport.js"
import { applyAttribution } from "../observability/attribution.js"

/**
 * Default org of an MCP request (ADR-051 §3). Each read tool names its org in
 * the `org` argument and ignores this default. `ctx_advisor` and request
 * attribution still use it until phase 3 removes `ctx_advisor`.
 *
 * - `?orgSlug=` that the principal can use, or a principal with one allowed
 *   org: that org is the default.
 * - `?orgSlug=` that the principal cannot use: 404, as before.
 * - No `?orgSlug=` and several allowed orgs: no default. `initialize`,
 *   `tools/list`, and the read tools work; tools name their org.
 */
const withMcpDefaultOrg: MiddlewareHandler<AppEnv> = async (c, next) => {
  const slug = c.req.query("orgSlug")?.trim() || undefined
  const result = await resolveCallOrg(callPrincipalFromContext(c), slug)
  if (result.ok) {
    c.set("orgSlug", result.org.slug)
    c.set("orgId", result.org.id)
    applyAttribution({
      "ctxpipe.org.id": result.org.id,
      "ctxpipe.org.slug": result.org.slug,
    })
    return withOrgIdContext(result.org, () => next())
  }
  if (slug) return c.json({ error: "Not found" }, 404)
  return next()
}

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
    withMcpDefaultOrg,
    (c) => handleMcpTransportRequest(c, registerTools, transportOptions),
  )
}
