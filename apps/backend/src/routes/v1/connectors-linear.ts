import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { orgHasAnyGithubConnection } from "../../models/github-installation.js"
import {
  deleteLinearConnectionById,
  getLinearSyncTargetWithRepoByConnectionId,
  listLinearScopesByConnectionId,
  MULTIPLE_LINEAR_CONNECTIONS_MESSAGE,
  resolveLinearConnectionForOrgDetailed,
  upsertLinearConnectionFromOAuth,
} from "../../models/linear-connector.js"
import {
  exchangeLinearOAuthCode,
  getLinearOAuthAuthorizeUrl,
  getLinearWorkspaceIdentity,
  linearTokenExpiresAt,
} from "../../services/linear/client.js"
import {
  createLinearOAuthState,
  verifyLinearOAuthState,
} from "../../services/linear/oauth-state.js"

const ErrorResponseSchema = z.object({ error: z.string() })
const ConnectionIdQuerySchema = z.object({
  connectionId: z.string().min(1).optional(),
})
const LinearOAuthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  state: z.string().optional(),
})

const getOAuthStartRoute = createRoute({
  method: "get",
  path: "/oauth/start",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ authorizationUrl: z.string().url() }),
        },
      },
      description: "Start Linear OAuth authorization",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Linear OAuth not configured",
    },
  },
})

const getStatusRoute = createRoute({
  method: "get",
  path: "/status",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            isInstalled: z.boolean(),
            installationStatus: z.string().nullable(),
            workspaceName: z.string().nullable(),
            isGithubLinked: z.boolean(),
            selectedScopeCount: z.number().int(),
            setupPhase: z.string(),
            pendingConfigPullUrl: z.string().nullable(),
            pendingConfigPrCreating: z.boolean(),
            syncTarget: z
              .object({
                repositoryId: z.string(),
                repositoryName: z.string(),
                githubConnectionId: z.string().nullable(),
                branch: z.string(),
              })
              .nullable(),
          }),
        },
      },
      description: "Current Linear connector setup status",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Ambiguous Linear connection",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown Linear connection",
    },
  },
})

const deleteLinearConnectorRoute = createRoute({
  method: "delete",
  path: "/",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    204: { description: "Linear connector removed" },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Ambiguous Linear connection",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown Linear connection",
    },
  },
})

const getOAuthCallbackRoute = createRoute({
  method: "get",
  path: "/callback",
  request: { query: LinearOAuthCallbackQuerySchema },
  responses: {
    200: {
      content: { "text/html": { schema: z.string() } },
      description: "Relay OAuth result to the connector popup opener",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid OAuth callback",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

function setupRelayResponse(input: {
  origin: string
  orgSlug: string
  connectionId: string
}): Response {
  const payload = JSON.stringify({
    type: "linear-oauth-complete",
    orgSlug: input.orgSlug,
    connectionId: input.connectionId,
  }).replaceAll("<", "\\u003c")
  const origin = JSON.stringify(input.origin)
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Linear connected</title><script>const result=${payload};try{window.opener?.postMessage(result,${origin});localStorage.setItem("linear-setup-result",JSON.stringify(result))}finally{window.close()}</script><p>Linear connected. You can close this window.</p>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  )
}

export const linearConnectorRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getOAuthStartRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    const orgId = c.get("orgId")
    const orgSlug = c.get("orgSlug") ?? c.req.param("orgSlug")
    if (!user || !session || !orgId || !orgSlug) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const env = c.var.env
    if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) {
      return c.json({ error: "Linear OAuth is not configured" }, 503)
    }
    return c.json(
      {
        authorizationUrl: getLinearOAuthAuthorizeUrl({
          env,
          state: createLinearOAuthState({
            authSecret: env.AUTH_SECRET,
            orgId,
            orgSlug,
            userId: user.id,
          }),
        }),
      },
      200,
    )
  })
  .openapi(getStatusRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const resolved = await resolveLinearConnectionForOrgDetailed(
      orgId,
      c.var.env,
      connectionId,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_LINEAR_CONNECTIONS_MESSAGE }, 400)
    }
    if (connectionId && resolved.status === "none") {
      return c.json({ error: "Unknown Linear connection" }, 404)
    }
    const connection =
      resolved.status === "ok" ? resolved.connection : undefined
    const [isGithubLinked, scopes, target] = await Promise.all([
      orgHasAnyGithubConnection(orgId),
      connection
        ? listLinearScopesByConnectionId(connection.id)
        : Promise.resolve([]),
      connection
        ? getLinearSyncTargetWithRepoByConnectionId(orgId, connection.id)
        : Promise.resolve(undefined),
    ])
    return c.json(
      {
        isInstalled: connection?.status === "installed",
        installationStatus: connection?.status ?? null,
        workspaceName: connection?.workspaceName ?? null,
        isGithubLinked,
        selectedScopeCount: scopes.length,
        setupPhase: target?.setupPhase ?? "draft",
        pendingConfigPullUrl: target?.pendingConfigPullUrl ?? null,
        pendingConfigPrCreating: target?.pendingConfigPrCreating ?? false,
        syncTarget: target
          ? {
              repositoryId: target.repositoryId,
              repositoryName: target.repositoryName,
              githubConnectionId: target.githubConnectionId,
              branch: target.branch,
            }
          : null,
      },
      200,
    )
  })
  .openapi(deleteLinearConnectorRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const resolved = await resolveLinearConnectionForOrgDetailed(
      orgId,
      c.var.env,
      connectionId,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_LINEAR_CONNECTIONS_MESSAGE }, 400)
    }
    if (resolved.status === "none") {
      return c.json({ error: "No Linear connection found for this org" }, 404)
    }
    const deleted = await deleteLinearConnectionById(
      orgId,
      resolved.connection.id,
    )
    return deleted
      ? c.body(null, 204)
      : c.json({ error: "No Linear connection found for this org" }, 404)
  })

export const linearOauthCallbackRoutes = new OpenAPIHono<AppEnv>().openapi(
  getOAuthCallbackRoute,
  async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)
    const query = LinearOAuthCallbackQuerySchema.parse({
      code: c.req.query("code") ?? undefined,
      error: c.req.query("error") ?? undefined,
      state: c.req.query("state") ?? undefined,
    })
    if (query.error) {
      return c.json(
        { error: `Linear authorization failed: ${query.error}` },
        400,
      )
    }
    if (!query.code || !query.state) {
      return c.json({ error: "Missing Linear OAuth code or state" }, 400)
    }
    const state = verifyLinearOAuthState({
      authSecret: c.var.env.AUTH_SECRET,
      state: query.state,
    })
    if (!state || state.userId !== user.id) {
      return c.json({ error: "Invalid Linear OAuth state" }, 400)
    }

    const token = await exchangeLinearOAuthCode({
      env: c.var.env,
      code: query.code,
    })
    const workspace = await getLinearWorkspaceIdentity(token.access_token)
    const connection = await withOrgDbContext(state.orgId, () =>
      upsertLinearConnectionFromOAuth({
        orgId: state.orgId,
        env: c.var.env,
        ownerUserId: user.id,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        accessTokenExpiresAt: linearTokenExpiresAt(token.expires_in),
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
        workspaceUrlKey: workspace.workspaceUrlKey,
        actorUserId: workspace.actorUserId,
      }),
    )
    return setupRelayResponse({
      origin: c.var.env.AUTH_BASE_URL.replace(/\/$/, ""),
      orgSlug: state.orgSlug,
      connectionId: connection.id,
    })
  },
)
