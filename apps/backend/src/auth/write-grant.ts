import { type RouteConfig, z } from "@hono/zod-openapi"
import type { MiddlewareHandler } from "hono"

import type { AppEnv } from "../app/env.js"

const WRITE_GRANT_NOTE =
  "Needs a signed-in session. An OAuth access token and an API key get 403 with the code `write_grant_required`."

const ORG_ADMIN_NOTE =
  "Also needs an org admin or owner session. An OAuth access token gets 403 from the org admin check."

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
 * session. An OAuth token and an API key get 403. An OAuth token gets 403
 * also when its stored grant lists `ctxpipe:write`, because ctxpipe offers no
 * write scope now. API keys have no permissions, so they
 * cannot hold a write grant. On REST, `requireAuth` refuses an org API key with
 * 401, and a personal API key on any method but GET, HEAD and OPTIONS with
 * this 403, so neither reaches this check. The check stays as defense in
 * depth for a route under /mcp or a route that skips `requireAuth`.
 */
const requireWriteGrant: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("personalApiKeyId") || c.get("orgApiKey")) {
    return c.json(
      {
        error:
          "API keys are read-only. Sign in to ctxpipe to make this change.",
        code: "write_grant_required",
      },
      403,
    )
  }
  if (c.get("oauthScopes")) {
    return c.json(
      {
        error:
          "Connected apps have read-only access. Sign in to ctxpipe to make this change.",
        code: "write_grant_required",
      },
      403,
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
