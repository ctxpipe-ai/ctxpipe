import type { Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import {
  captureAuthApiErrors,
  transientAuthUnavailableResponse,
} from "../auth/transient-api-error.js"
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
import { getLogger } from "../observability/logger.js"

export function registerMcpRoutes(app: Hono<AppEnv>) {
  app.all(
    "/mcp",
    (c, next) => rejectInvalidMcpOrigin(c) ?? next(),
    async (c, next) => {
      const outcome = await captureAuthApiErrors(() => next())
      if (outcome.transientDatabaseError) {
        getLogger().error(
          outcome.ok
            ? new Error(
                "MCP authentication returned after a transient database failure",
              )
            : outcome.error instanceof Error
              ? outcome.error
              : new Error("MCP authentication failed"),
          {
            step: "mcp.auth.database_unavailable",
            databaseError: outcome.transientDatabaseError,
          },
        )
        c.res = transientAuthUnavailableResponse()
        return
      }
      if (!outcome.ok) throw outcome.error
    },
    withCookieAuth,
    withBearerAuth,
    requireAuth,
    withNetworkOrgContext,
    (c) => handleMcpTransportRequest(c, registerMcpTools),
  )
}
