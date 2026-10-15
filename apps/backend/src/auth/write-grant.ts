import { type RouteConfig, z } from "@hono/zod-openapi"
import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../app/env.js"
import { MCP_SCOPES, MCP_WRITE_SCOPE, quoteHeaderValue } from "./mcp-scopes.js"

const WRITE_GRANT_NOTE = `Needs a signed-in session, or an OAuth access token with the \`${MCP_WRITE_SCOPE}\` scope. An OAuth token without that scope and an API key get 403 with the code \`write_grant_required\`.`

const ORG_ADMIN_NOTE = `Also needs an org admin or owner session. An OAuth access token gets 403 from the org admin check, also with the \`${MCP_WRITE_SCOPE}\` scope.`

/**
 * The 403 of a direct-write route. `code` is optional because a check in
 * front of the gate, such as the org admin check, can refuse first without it.
 */
function forbiddenResponse(description: string) {
  return {
    content: {
      "application/json": {
        schema: z.object({
          error: z.string(),
          code: z.literal("write_grant_required").optional(),
        }),
      },
    },
    description,
  }
}

/**
 * Let a request through only when its principal can write to the default
 * branch of a Workspace repository without a pull request: a signed-in
 * session, or an OAuth token with `ctxpipe:write`. An OAuth token without
 * that scope and an API key get 403. API keys have no permissions, so they
 * cannot hold a write grant.
 */
export const requireWriteGrant: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("personalApiKeyId") || c.get("orgApiKey")) {
    return c.json(
      {
        error:
          "API keys are read-only. Sign in, or use an OAuth token with the ctxpipe:write scope.",
        code: "write_grant_required",
      },
      403,
    )
  }
  const scopes = c.get("oauthScopes")
  if (scopes && !scopes.includes(MCP_WRITE_SCOPE)) {
    const description = `This change needs the ${MCP_WRITE_SCOPE} scope`
    return c.json(
      {
        error: `${description}. Reconnect and allow it.`,
        code: "write_grant_required",
      },
      403,
      {
        "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${MCP_SCOPES.join(" ")}", error_description="${quoteHeaderValue(description)}"`,
      },
    )
  }
  return next()
}

/**
 * Put {@link requireWriteGrant} on a route that causes a direct write, and
 * state the grant and its 403 response in the OpenAPI contract of the route.
 * Set `orgAdmin` when an org admin check is also in front of the route.
 * The return type leaves out `middleware`: its untyped path would widen the
 * route path that the `hc` client infers.
 */
export function directWriteRoute<
  // A separate path parameter keeps the path literal, as in `createRoute`.
  P extends string,
  R extends RouteConfig & { path: P },
>(
  route: R,
  options?: { orgAdmin: true },
): R & {
  responses: R["responses"] & { 403: ReturnType<typeof forbiddenResponse> }
} {
  const note = options?.orgAdmin
    ? `${WRITE_GRANT_NOTE} ${ORG_ADMIN_NOTE}`
    : WRITE_GRANT_NOTE
  return {
    ...route,
    middleware: requireWriteGrant,
    description: route.description ? `${route.description}\n\n${note}` : note,
    responses: {
      ...route.responses,
      403: forbiddenResponse(
        options?.orgAdmin
          ? "Not an org admin or owner (no `code`), or no write grant (`write_grant_required`)"
          : "No write grant (`write_grant_required`)",
      ),
    },
  }
}
