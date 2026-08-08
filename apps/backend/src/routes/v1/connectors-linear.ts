import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { orgHasAnyGithubConnection } from "../../models/github-installation.js"
import {
  deleteLinearConnectionById,
  getLinearSyncTargetWithRepoByConnectionId,
  type LinearConnection,
  listLinearScopesByConnectionId,
  MULTIPLE_LINEAR_CONNECTIONS_MESSAGE,
  patchLinearConnectorConfig,
  resolveLinearConnectionForOrgDetailed,
  updateLinearConnectionTokens,
  upsertLinearConnectionFromOAuth,
} from "../../models/linear-connector.js"
import { getLogger } from "../../observability/logger.js"
import { enqueueRepositoryIngestionWorkflow } from "../../openworkflow/enqueue-repository-ingestion.js"
import {
  discoverLinearScopes,
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

const LinearScopeSchema = z.object({
  externalId: z.string().min(1),
  type: z.enum(["team", "project", "document", "initiative"]),
  title: z.string().min(1),
  url: z.string().url().nullable().optional(),
  parentExternalId: z.string().nullable().optional(),
  teamId: z.string().nullable().optional(),
  teamKey: z.string().nullable().optional(),
})

const LinearSyncTargetSchema = z
  .object({
    repositoryId: z.string().min(1).optional(),
    repositoryName: z.string().min(1).optional(),
    gitUrl: z.string().url().optional(),
    githubConnectionId: z.string().min(1).optional(),
    branch: z.string().min(1),
    enabled: z.boolean(),
  })
  .refine(
    (value) =>
      Boolean(value.repositoryId) ||
      (Boolean(value.repositoryName) && Boolean(value.gitUrl)),
    { message: "Provide repositoryId or both repositoryName and gitUrl" },
  )

const LinearPatchConfigRequestSchema = z
  .object({
    scopes: z.array(LinearScopeSchema).optional(),
    syncTarget: LinearSyncTargetSchema.optional(),
  })
  .refine(
    (body) => body.scopes !== undefined || body.syncTarget !== undefined,
    { message: "Provide scopes or syncTarget" },
  )

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

const listAvailableScopesRoute = createRoute({
  method: "get",
  path: "/available-scopes",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ items: z.array(LinearScopeSchema) }),
        },
      },
      description:
        "List selectable Linear teams, projects, documents, and initiatives",
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

const getConfigRoute = createRoute({
  method: "get",
  path: "/config",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            scopes: z.array(LinearScopeSchema),
            syncTarget: z
              .object({
                repositoryId: z.string(),
                repositoryName: z.string(),
                githubConnectionId: z.string().nullable(),
                branch: z.string(),
                enabled: z.boolean(),
                setupPhase: z.string(),
                pendingConfigPullUrl: z.string().nullable(),
                pendingConfigPrCreating: z.boolean(),
              })
              .nullable(),
          }),
        },
      },
      description: "Current draft Linear connector configuration",
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

const patchConfigRoute = createRoute({
  method: "patch",
  path: "/config",
  request: {
    query: ConnectionIdQuerySchema,
    body: {
      content: {
        "application/json": {
          schema: LinearPatchConfigRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            accepted: z.literal(true),
            savedCount: z.number().int(),
          }),
        },
      },
      description: "Save draft Linear scope and repository selection",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid or ambiguous Linear configuration",
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

async function resolveInstalledLinear(
  orgId: string,
  env: AppEnv["Variables"]["env"],
  connectionId?: string,
): Promise<
  | { status: "ok"; connection: LinearConnection }
  | { status: "error"; error: string; httpStatus: 400 | 404 }
> {
  const resolved = await resolveLinearConnectionForOrgDetailed(
    orgId,
    env,
    connectionId,
  )
  if (resolved.status === "ambiguous") {
    return {
      status: "error",
      error: MULTIPLE_LINEAR_CONNECTIONS_MESSAGE,
      httpStatus: 400,
    }
  }
  if (resolved.status === "none") {
    return {
      status: "error",
      error: "Unknown Linear connection",
      httpStatus: 404,
    }
  }
  return { status: "ok", connection: resolved.connection }
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
  .openapi(listAvailableScopesRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const installed = await resolveInstalledLinear(
      orgId,
      c.var.env,
      connectionId,
    )
    if (installed.status === "error") {
      return c.json({ error: installed.error }, installed.httpStatus)
    }
    const items = await discoverLinearScopes({
      env: c.var.env,
      connection: installed.connection,
      onTokenRefresh: async (tokens) => {
        await updateLinearConnectionTokens({
          orgId,
          connectionId: installed.connection.id,
          env: c.var.env,
          ...tokens,
        })
      },
    })
    return c.json({ items }, 200)
  })
  .openapi(getConfigRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const installed = await resolveInstalledLinear(
      orgId,
      c.var.env,
      connectionId,
    )
    if (installed.status === "error") {
      return c.json({ error: installed.error }, installed.httpStatus)
    }
    const [scopes, target] = await Promise.all([
      listLinearScopesByConnectionId(installed.connection.id),
      getLinearSyncTargetWithRepoByConnectionId(orgId, installed.connection.id),
    ])
    return c.json(
      {
        scopes: scopes.map((scope) => ({
          externalId: scope.externalId,
          type: scope.type,
          title: scope.title,
          url: scope.url,
          parentExternalId: scope.parentExternalId,
          teamId: scope.teamId,
          teamKey: scope.teamKey,
        })),
        syncTarget: target
          ? {
              repositoryId: target.repositoryId,
              repositoryName: target.repositoryName,
              githubConnectionId: target.githubConnectionId,
              branch: target.branch,
              enabled: target.enabled,
              setupPhase: target.setupPhase,
              pendingConfigPullUrl: target.pendingConfigPullUrl,
              pendingConfigPrCreating: target.pendingConfigPrCreating,
            }
          : null,
      },
      200,
    )
  })
  .openapi(patchConfigRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const installed = await resolveInstalledLinear(
      orgId,
      c.var.env,
      connectionId,
    )
    if (installed.status === "error") {
      return c.json({ error: installed.error }, installed.httpStatus)
    }
    const body = LinearPatchConfigRequestSchema.parse(await c.req.json())
    const saved = await patchLinearConnectorConfig({
      orgId,
      connectionId: installed.connection.id,
      ...(body.scopes !== undefined ? { scopes: body.scopes } : {}),
      ...(body.syncTarget !== undefined ? { syncTarget: body.syncTarget } : {}),
    })
    if (saved.repositoryIngestion) {
      await enqueueRepositoryIngestionWorkflow(
        {
          orgId: saved.repositoryIngestion.orgId,
          repositoryId: saved.repositoryIngestion.repositoryId,
        },
        {
          error: (error) =>
            getLogger().error(error, {
              step: "linear.repository_ingestion.enqueue",
            }),
        },
      )
    }
    return c.json(
      { accepted: true as const, savedCount: saved.scopes.length },
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
