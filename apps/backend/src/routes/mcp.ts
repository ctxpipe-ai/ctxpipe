import type { Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import {
  requireAuth,
  withBearerAuth,
  withCookieAuth,
  withNetworkOrgContext,
} from "../auth/withAuth.js"
import { registerMcpTools } from "../mcp/tools.js"
import {
  handleMcpTransportRequest,
  rejectInvalidMcpOrigin,
} from "../mcp/transport.js"

export function registerMcpRoutes(app: Hono<AppEnv>) {
  app.all(
    "/mcp",
    (c, next) => rejectInvalidMcpOrigin(c) ?? next(),
    withCookieAuth,
    withBearerAuth,
    requireAuth,
    withNetworkOrgContext,
    (c) => handleMcpTransportRequest(c, registerMcpTools),
  )
}
