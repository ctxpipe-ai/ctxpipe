import type { RouteConfig } from "@hono/zod-openapi"
import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../app/env.js"
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "./mcp-scopes.js"

const WRITE_GRANT_NOTE = `Needs a signed-in session, or an OAuth access token with the \`${MCP_WRITE_SCOPE}\` scope. An OAuth token without that scope and an API key get 403 with the code \`write_grant_required\`.`

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
        "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}", error_description="${description}"`,
      },
    )
  }
  return next()
}

/**
 * Put {@link requireWriteGrant} on a route that queues a direct write, and
 * state the grant in the OpenAPI description of the route.
 */
export function directWriteRoute<R extends RouteConfig>(route: R): R {
  if (route.middleware) {
    throw new Error(`${route.path}: directWriteRoute sets the route middleware`)
  }
  const forbidden = route.responses[403]
  return {
    ...route,
    middleware: requireWriteGrant,
    description: route.description
      ? `${route.description}\n\n${WRITE_GRANT_NOTE}`
      : WRITE_GRANT_NOTE,
    responses: {
      ...route.responses,
      403:
        forbidden && "description" in forbidden
          ? {
              ...forbidden,
              description: `${forbidden.description} Also: no write grant (\`write_grant_required\`).`,
            }
          : (forbidden ?? {
              description: "No write grant (`write_grant_required`)",
            }),
    },
  } as R
}
