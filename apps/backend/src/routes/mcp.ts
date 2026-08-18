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
    withCookieAuth,
    withBearerAuth,
    requireAuth,
    withNetworkOrgContext,
    (c) => handleMcpTransportRequest(c, registerMcpTools),
  )
}
