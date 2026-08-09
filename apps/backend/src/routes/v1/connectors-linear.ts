import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { hasOrgAdminOrOwnerRole } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { orgHasAnyGithubConnection } from "../../models/github-installation.js"
import {
  claimLinearContentSyncRetry,
  deleteLinearConnectionById,
  getLinearSyncTargetWithRepoByConnectionId,
  LinearConfigPrCreationInProgressError,
  type LinearConnection,
  type LinearScope,
  type LinearSyncTargetWithRepo,
  MULTIPLE_LINEAR_CONNECTIONS_MESSAGE,
  patchLinearConnectorConfig,
  refreshLinearConnectionTokensWithLock,
  releaseLinearConfigPrCreationClaim,
  resolveLinearConnectionForOrgDetailed,
  updateLinearSyncTargetPrState,
  upsertLinearConnectionFromOAuth,
} from "../../models/linear-connector.js"
import { getLogger } from "../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../openworkflow/client.js"
import { enqueueRepositoryIngestionWorkflow } from "../../openworkflow/enqueue-repository-ingestion.js"
import { linearSyncConfig } from "../../openworkflow/workflows/linear-sync-config.js"
import { linearSyncContent } from "../../openworkflow/workflows/linear-sync-content.js"
import { linearSyncIncremental } from "../../openworkflow/workflows/linear-sync-incremental.js"
import { getPullRequestHeadBranch } from "../../services/github/installation-write-client.js"
import {
  discoverLinearScopes,
  exchangeLinearOAuthCode,
  getLinearOAuthAuthorizeUrl,
  getLinearWorkspaceIdentity,
  linearTokenExpiresAt,
  refreshLinearOAuthToken,
} from "../../services/linear/client.js"
import { loadLinearScopeFromRepo } from "../../services/linear/config-from-repo.js"
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
  url: z.string().url().nullable().default(null),
  parentExternalId: z.string().nullable().default(null),
  teamId: z.string().nullable().default(null),
  teamKey: z.string().nullable().default(null),
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
            configPrEnqueued: z.boolean(),
            workflowName: z.string().optional(),
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
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Linear configuration pull request creation is in progress",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Failed to enqueue Linear configuration pull request",
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

const retryLinearSyncRoute = createRoute({
  method: "post",
  path: "/retry",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({ accepted: z.literal(true) }),
        },
      },
      description: "Retry a failed Linear content sync",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Ambiguous Linear connection",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Linear content sync retry already claimed",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown or incomplete Linear connection",
    },
  },
})

const retryLinearConfigRoute = createRoute({
  method: "post",
  path: "/retry-config",
  request: {
    query: ConnectionIdQuerySchema,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              scopes: z.array(LinearScopeSchema).optional(),
            })
            .optional(),
        },
      },
      required: false,
    },
  },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({ accepted: z.literal(true) }),
        },
      },
      description: "Retry Linear configuration pull request creation",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Ambiguous or incomplete Linear connection",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown Linear connection",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Configuration pull request creation already in progress",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Failed to enqueue configuration pull request creation",
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
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No longer an organization administrator",
    },
  },
})

function setupRelayResponse(input: {
  origin: string
  orgSlug: string
  result:
    | { type: "linear-oauth-complete"; connectionId: string }
    | { type: "linear-oauth-error"; error: string }
}): Response {
  const payload = JSON.stringify({
    orgSlug: input.orgSlug,
    ...input.result,
  }).replaceAll("<", "\\u003c")
  const origin = JSON.stringify(input.origin)
  const connected = input.result.type === "linear-oauth-complete"
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${connected ? "Linear connected" : "Linear authorization failed"}</title><script>const result=${payload};try{window.opener?.postMessage(result,${origin});localStorage.setItem("linear-setup-result",JSON.stringify(result))}finally{window.close()}</script><p>${connected ? "Linear connected." : "Linear authorization failed."} You can close this window.</p>`,
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
  if (resolved.connection.status !== "installed") {
    return {
      status: "error",
      error: "Linear authorization is revoked; reconnect the workspace",
      httpStatus: 400,
    }
  }
  return { status: "ok", connection: resolved.connection }
}

async function loadLinearScopesFromGit(input: {
  orgId: string
  env: AppEnv["Variables"]["env"]
  target: LinearSyncTargetWithRepo | undefined
  fallbackToTargetBranch?: boolean
}): Promise<LinearScope[]> {
  const { target } = input
  if (!target?.githubConnectionId) return []

  let branch: string | undefined
  if (
    target.setupPhase === "live" ||
    target.setupPhase === "initial_sync" ||
    target.setupPhase === "sync_failed"
  ) {
    branch = target.branch
  } else if (
    (target.setupPhase === "awaiting_merge" ||
      target.setupPhase === "config_failed") &&
    target.pendingConfigPullUrl
  ) {
    branch = await getPullRequestHeadBranch({
      orgId: input.orgId,
      env: input.env,
      repositoryName: target.repositoryName,
      githubConnectionId: target.githubConnectionId,
      pullUrl: target.pendingConfigPullUrl,
    })
  }
  if (!branch && input.fallbackToTargetBranch) branch = target.branch
  if (!branch) return []

  return (
    (
      await loadLinearScopeFromRepo({
        orgId: input.orgId,
        env: input.env,
        repositoryName: target.repositoryName,
        githubConnectionId: target.githubConnectionId,
        branch,
      })
    )?.scopes ?? []
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
    const [isGithubLinked, target] = await Promise.all([
      orgHasAnyGithubConnection(orgId),
      connection
        ? getLinearSyncTargetWithRepoByConnectionId(orgId, connection.id)
        : Promise.resolve(undefined),
    ])
    const scopes = await loadLinearScopesFromGit({
      orgId,
      env: c.var.env,
      target,
    })
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
      onTokenRefresh: (expectedRefreshToken, expectedAccessToken) =>
        withOrgDbContext(orgId, () =>
          refreshLinearConnectionTokensWithLock({
            orgId,
            connectionId: installed.connection.id,
            env: c.var.env,
            expectedRefreshToken,
            expectedAccessToken,
            refresh: async (refreshToken) => {
              const token = await refreshLinearOAuthToken({
                env: c.var.env,
                refreshToken,
              })
              return {
                accessToken: token.access_token,
                refreshToken: token.refresh_token ?? refreshToken,
                accessTokenExpiresAt: linearTokenExpiresAt(token.expires_in),
              }
            },
          }),
        ),
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
    const target = await getLinearSyncTargetWithRepoByConnectionId(
      orgId,
      installed.connection.id,
    )
    const scopes = await loadLinearScopesFromGit({
      orgId,
      env: c.var.env,
      target,
    })
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
    const orgSlug = c.get("orgSlug") ?? c.req.param("orgSlug")
    if (!orgSlug) return c.json({ error: "Unauthorized" }, 401)
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
    let saved: Awaited<ReturnType<typeof patchLinearConnectorConfig>>
    try {
      saved = await patchLinearConnectorConfig({
        orgId,
        connectionId: installed.connection.id,
        claimConfigPrCreation: body.scopes !== undefined,
        ...(body.scopes !== undefined ? { scopes: body.scopes } : {}),
        ...(body.syncTarget !== undefined
          ? { syncTarget: body.syncTarget }
          : {}),
      })
    } catch (error) {
      if (error instanceof LinearConfigPrCreationInProgressError) {
        return c.json({ error: error.message }, 409)
      }
      throw error
    }
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
    if (saved.configPrClaimed && body.scopes !== undefined) {
      try {
        await runWorkflowWithWorkerWake(linearSyncConfig.spec, {
          orgId,
          orgSlug,
          connectionId: installed.connection.id,
          scopes: body.scopes,
        })
      } catch (error) {
        await updateLinearSyncTargetPrState({
          connectionId: installed.connection.id,
          pendingConfigPullUrl:
            saved.previousConfigPrState?.pendingConfigPullUrl ?? null,
          pendingConfigPrCreating: false,
          setupPhase: "config_failed",
        })
        getLogger().error(
          error instanceof Error ? error : new Error(String(error)),
          {
            step: "linear.config_pr.enqueue",
            connectionId: installed.connection.id,
          },
        )
        return c.json(
          { error: "Failed to enqueue Linear configuration pull request" },
          503,
        )
      }
    }
    return c.json(
      {
        accepted: true as const,
        savedCount: saved.scopes.length,
        configPrEnqueued: saved.configPrClaimed,
        ...(saved.configPrClaimed
          ? { workflowName: linearSyncConfig.spec.name }
          : {}),
      },
      200,
    )
  })
  .openapi(retryLinearConfigRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    const orgSlug = c.get("orgSlug") ?? c.req.param("orgSlug")
    if (!orgId || !orgSlug) return c.json({ error: "Unauthorized" }, 401)
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
    const target = await getLinearSyncTargetWithRepoByConnectionId(
      orgId,
      installed.connection.id,
    )
    if (target?.setupPhase !== "config_failed") {
      return c.json(
        { error: "Linear configuration pull request is not in a failed state" },
        400,
      )
    }
    const body = z
      .object({ scopes: z.array(LinearScopeSchema).optional() })
      .catch({})
      .parse(await c.req.json().catch(() => ({})))
    const gitScopes = await loadLinearScopesFromGit({
      orgId,
      env: c.var.env,
      target,
      fallbackToTargetBranch: true,
    })
    const scopes = body.scopes ?? gitScopes
    if (scopes.length === 0) {
      return c.json(
        {
          error:
            "Linear scope draft is missing from git; re-submit scopes via PATCH or retry-config body",
        },
        400,
      )
    }
    let saved: Awaited<ReturnType<typeof patchLinearConnectorConfig>>
    try {
      saved = await patchLinearConnectorConfig({
        orgId,
        connectionId: installed.connection.id,
        scopes,
        claimConfigPrCreation: true,
      })
    } catch (error) {
      if (error instanceof LinearConfigPrCreationInProgressError) {
        return c.json({ error: error.message }, 409)
      }
      throw error
    }
    if (!saved.configPrClaimed || !saved.previousConfigPrState) {
      return c.json({ error: "Linear scope is not configured" }, 400)
    }
    try {
      await runWorkflowWithWorkerWake(linearSyncConfig.spec, {
        orgId,
        orgSlug,
        connectionId: installed.connection.id,
        scopes,
      })
    } catch (error) {
      await releaseLinearConfigPrCreationClaim({
        connectionId: installed.connection.id,
        previousState: saved.previousConfigPrState,
      })
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        {
          step: "linear.config_pr.retry_enqueue",
          connectionId: installed.connection.id,
        },
      )
      return c.json(
        { error: "Failed to enqueue Linear configuration pull request" },
        503,
      )
    }
    return c.json({ accepted: true as const }, 202)
  })
  .openapi(retryLinearSyncRoute, async (c) => {
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
    const target = await getLinearSyncTargetWithRepoByConnectionId(
      orgId,
      installed.connection.id,
    )
    if (!target) {
      return c.json({ error: "Linear sync target is not configured" }, 404)
    }
    if (target.setupPhase !== "sync_failed") {
      return c.json(
        { error: "Linear content sync is not in a failed state" },
        400,
      )
    }
    if (!(await claimLinearContentSyncRetry(installed.connection.id))) {
      return c.json(
        { error: "Linear content sync is already being retried" },
        409,
      )
    }
    try {
      await runWorkflowWithWorkerWake(linearSyncContent.spec, {
        orgId,
        connectionId: installed.connection.id,
      })
    } catch (error) {
      await updateLinearSyncTargetPrState({
        connectionId: installed.connection.id,
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
        setupPhase: "sync_failed",
      })
      throw error
    }
    return c.json({ accepted: true as const }, 202)
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
    if (!query.state) {
      return c.json({ error: "Missing Linear OAuth state" }, 400)
    }
    const state = verifyLinearOAuthState({
      authSecret: c.var.env.AUTH_SECRET,
      state: query.state,
    })
    if (!state || state.userId !== user.id) {
      return c.json({ error: "Invalid Linear OAuth state" }, 400)
    }
    const origin = new URL(c.var.env.AUTH_BASE_URL).origin
    const relayError = (error: string) =>
      setupRelayResponse({
        origin,
        orgSlug: state.orgSlug,
        result: { type: "linear-oauth-error", error },
      })
    if (query.error) {
      return relayError(`Linear authorization failed: ${query.error}`)
    }
    if (!query.code) {
      return c.json({ error: "Missing Linear OAuth code" }, 400)
    }
    if (
      !(await hasOrgAdminOrOwnerRole({
        headers: c.req.raw.headers,
        orgId: state.orgId,
      }))
    ) {
      return relayError(
        "You no longer have permission to connect Linear to this organisation",
      )
    }

    try {
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
      const target = await getLinearSyncTargetWithRepoByConnectionId(
        state.orgId,
        connection.id,
      )
      if (target?.enabled && target.setupPhase === "live") {
        await runWorkflowWithWorkerWake(linearSyncIncremental.spec, {
          orgId: state.orgId,
          connectionId: connection.id,
        })
      }
      return setupRelayResponse({
        origin,
        orgSlug: state.orgSlug,
        result: {
          type: "linear-oauth-complete",
          connectionId: connection.id,
        },
      })
    } catch (error) {
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "linear.oauth_callback" },
      )
      return relayError(
        "Linear authorization could not be completed. Close this window and try again.",
      )
    }
  },
)
