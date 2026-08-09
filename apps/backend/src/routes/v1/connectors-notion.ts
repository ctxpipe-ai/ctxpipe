import { createHmac, timingSafeEqual } from "node:crypto"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { orgHasAnyGithubConnection } from "../../models/github-installation.js"
import {
  claimNotionConfigPrCreation,
  claimNotionContentSyncRetry,
  deleteNotionConnectionById,
  getNotionBindingWithRepoByConnectionId,
  MULTIPLE_NOTION_CONNECTIONS_MESSAGE,
  type NotionBindingWithRepo,
  patchNotionConnectorConfig,
  releaseNotionConfigPrCreationClaim,
  resolveNotionConnectionForOrgDetailed,
  transitionNotionBindingState,
  updateNotionConnectionTokens,
  upsertNotionConnectionFromOAuth,
} from "../../models/notion-connector.js"
import { getLogger } from "../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../openworkflow/client.js"
import { enqueueRepositoryIngestionWorkflow } from "../../openworkflow/enqueue-repository-ingestion.js"
import { notionSyncConfig } from "../../openworkflow/workflows/notion-sync-config.js"
import { notionSyncContent } from "../../openworkflow/workflows/notion-sync-content.js"
import { getPullRequestHeadBranch } from "../../services/github/installation-write-client.js"
import {
  exchangeNotionOAuthCode,
  getNotionOAuthAuthorizeUrl,
  searchNotionResources,
} from "../../services/notion/client.js"
import { loadNotionScopeFromRepo } from "../../services/notion/config-from-repo.js"
import { notionResourcesEqual } from "../../services/notion/config-yaml.js"

const ErrorResponseSchema = z
  .object({
    error: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .openapi("NotionConnectorErrorResponse")

const ConnectionIdQuerySchema = z.object({
  connectionId: z.string().min(1).optional(),
})

const NotionOAuthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
})

const NOTION_SETUP_RESULT_KEY = "notion-setup-result"

const NotionStatusResponseSchema = z
  .object({
    isInstalled: z.boolean(),
    installationStatus: z.string().nullable(),
    workspaceName: z.string().nullable(),
    isGithubLinked: z.boolean(),
    selectedResourceCount: z.number(),
    syncTargetConfigured: z.boolean(),
    setupPhase: z.string(),
    pendingConfigPullUrl: z.string().nullable(),
    pendingConfigPrCreating: z.boolean(),
    syncTarget: z
      .object({
        repositoryId: z.string(),
        repositoryName: z.string(),
        branch: z.string(),
        githubConnectionId: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("NotionConnectorStatusResponse")

const NotionResourceSchema = z.object({
  externalId: z.string(),
  type: z.enum(["page", "database"]),
  title: z.string(),
  url: z.string().nullable().optional(),
  parentExternalId: z.string().nullable().optional(),
})

const SaveBindingSchema = z
  .object({
    repositoryId: z.string().min(1).optional(),
    repositoryName: z.string().min(1).optional(),
    gitUrl: z.string().url().optional(),
    githubConnectionId: z.string().min(1).optional(),
    branch: z.string().min(1),
    enabled: z.boolean(),
  })
  .refine(
    (v) =>
      Boolean(v.repositoryId) ||
      (Boolean(v.repositoryName) && Boolean(v.gitUrl)),
    { message: "Provide repositoryId or both repositoryName and gitUrl" },
  )

const NotionPatchConfigRequestSchema = z
  .object({
    resources: z.array(NotionResourceSchema).optional(),
    syncTarget: SaveBindingSchema.optional(),
  })
  .refine(
    (body) => body.resources !== undefined || body.syncTarget !== undefined,
    { message: "Provide at least one of resources or syncTarget" },
  )
  .openapi("NotionPatchConfigRequest")

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
      description: "Start Notion OAuth authorization",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid org route",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Notion OAuth not configured",
    },
  },
})

const getOAuthCallbackRoute = createRoute({
  method: "get",
  path: "/oauth/callback",
  request: {
    query: NotionOAuthCallbackQuerySchema,
  },
  responses: {
    200: {
      description: "Relay OAuth result back to the connector popup opener",
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

const getStatusRoute = createRoute({
  method: "get",
  path: "/status",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: NotionStatusResponseSchema } },
      description: "Current Notion connector setup status",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple Notion connections; pass connectionId",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown connectionId",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

const listAvailableResourcesRoute = createRoute({
  method: "get",
  path: "/available-resources",
  request: {
    query: ConnectionIdQuerySchema.extend({
      q: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(NotionResourceSchema),
          }),
        },
      },
      description: "List accessible Notion pages/databases",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple Notion connections; pass connectionId",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown connectionId",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Notion connection is not installed",
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
            resources: z.array(NotionResourceSchema),
            syncTarget: z
              .object({
                id: z.string(),
                orgId: z.string(),
                connectionId: z.string(),
                repositoryId: z.string(),
                repositoryName: z.string(),
                githubConnectionId: z.string().nullable(),
                branch: z.string(),
                enabled: z.boolean(),
                setupPhase: z.string(),
                pendingConfigPullUrl: z.string().nullable(),
                pendingConfigPrCreating: z.boolean(),
                createdAt: z.string().datetime(),
                updatedAt: z.string().datetime(),
              })
              .nullable(),
          }),
        },
      },
      description: "Current Notion connector config",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple Notion connections; pass connectionId",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown connectionId",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Notion connection not installed",
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
        "application/json": { schema: NotionPatchConfigRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            accepted: z.literal(true),
            savedCount: z.number(),
            configPrEnqueued: z.boolean(),
            workflowName: z.string().optional(),
          }),
        },
      },
      description: "Config patched; opens/updates Notion config PR",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid request or ambiguous connection",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown connectionId",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Notion connection is not installed",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Failed to enqueue configuration pull request",
    },
  },
})

const deleteNotionConnectorRoute = createRoute({
  method: "delete",
  path: "/",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    204: { description: "Notion connector removed" },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple Notion connections; pass connectionId",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown connectionId",
    },
  },
})

const retryNotionSyncRoute = createRoute({
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
      description: "Retry a failed Notion content sync",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Ambiguous or non-failed Notion connection",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown or incomplete Notion connection",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Notion content sync retry already claimed",
    },
  },
})

const retryNotionConfigRoute = createRoute({
  method: "post",
  path: "/retry-config",
  request: {
    query: ConnectionIdQuerySchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            resources: z.array(NotionResourceSchema).optional(),
          }),
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
      description: "Retry Notion configuration pull request creation",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Ambiguous or incomplete Notion connection",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown Notion connection",
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

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8")
}

function signState(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url")
}

function makeOAuthState(input: {
  orgId: string
  userId: string
  orgSlug: string
  secret: string
}): string {
  const payload = encodeBase64Url(
    JSON.stringify({
      orgId: input.orgId,
      userId: input.userId,
      orgSlug: input.orgSlug,
      ts: Date.now(),
    }),
  )
  return `${payload}.${signState(payload, input.secret)}`
}

function parseOAuthState(
  state: string,
  secret: string,
): { orgId: string; userId: string; orgSlug: string; ts: number } | undefined {
  const [payload, signature] = state.split(".")
  if (!payload || !signature) return undefined
  const expected = signState(payload, secret)
  const sig = Buffer.from(signature)
  const exp = Buffer.from(expected)
  if (sig.length !== exp.length || !timingSafeEqual(sig, exp)) return undefined
  const parsed = z
    .object({
      orgId: z.string(),
      userId: z.string(),
      orgSlug: z.string(),
      ts: z.number(),
    })
    .safeParse(JSON.parse(decodeBase64Url(payload)))
  if (!parsed.success) return undefined
  if (Date.now() - parsed.data.ts > 10 * 60 * 1000) return undefined
  return parsed.data
}

function notionRedirectUri(input: {
  baseUrl: string
  override?: string
}): string {
  if (input.override) return input.override
  return `${input.baseUrl.replace(/\/$/, "")}/api/v1/connectors/notion/oauth/callback`
}

function notionSetupRelayPath(input: {
  orgSlug: string
  connectionId?: string
  error?: string
}) {
  const params = new URLSearchParams({ orgSlug: input.orgSlug })
  if (input.connectionId) params.set("connectionId", input.connectionId)
  if (input.error) params.set("error", input.error)
  return `/.notion/setup?${params.toString()}`
}

function notionSetupRelayResponse(input: {
  orgSlug: string
  connectionId?: string
  error?: string
}) {
  const result = {
    connectionId: input.connectionId,
    error: input.error,
  }
  const fallbackPath = notionSetupRelayPath(input)

  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Notion connected</title>
  </head>
  <body>
    <script>
      (function () {
        try {
          window.localStorage.setItem(
            ${JSON.stringify(NOTION_SETUP_RESULT_KEY)},
            JSON.stringify(${JSON.stringify(result)})
          );
        } catch (_) {}
        window.close();
        window.setTimeout(function () {
          window.location.replace(${JSON.stringify(fallbackPath)});
        }, 500);
      })();
    </script>
  </body>
</html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    },
  )
}

async function resolveInstalledNotion(
  orgId: string,
  env: AppEnv["Variables"]["env"],
  connectionId?: string | null,
) {
  const resolved = await resolveNotionConnectionForOrgDetailed(
    orgId,
    env,
    connectionId,
  )
  if (resolved.status === "ambiguous") {
    return { error: MULTIPLE_NOTION_CONNECTIONS_MESSAGE, status: 400 as const }
  }
  if (resolved.status === "none") {
    return {
      error: "No Notion connection found for this org",
      status: 404 as const,
    }
  }
  if (
    resolved.connection.status !== "installed" ||
    !resolved.connection.accessToken
  ) {
    return { error: "Notion connection is not installed", status: 409 as const }
  }
  return { connection: resolved.connection }
}

type NotionGitResource = {
  externalId: string
  type: "page" | "database"
  title: string
}

/**
 * Load the git-native Notion scope for a binding, mirroring the connector
 * lifecycle: read from the target branch once live/initial-sync, from the open
 * config PR head while awaiting merge, otherwise fall back to the target branch
 * when asked (used for change-detection during PATCH).
 */
async function loadNotionResourcesFromGit(input: {
  orgId: string
  env: AppEnv["Variables"]["env"]
  binding: NotionBindingWithRepo | undefined
  fallbackToTargetBranch?: boolean
}): Promise<NotionGitResource[]> {
  const { binding } = input
  if (!binding?.githubConnectionId) return []

  let branch: string | undefined
  if (binding.setupPhase === "live" || binding.setupPhase === "initial_sync") {
    branch = binding.branch
  } else if (
    (binding.setupPhase === "awaiting_merge" ||
      binding.setupPhase === "config_failed") &&
    binding.pendingConfigPullUrl
  ) {
    branch = await getPullRequestHeadBranch({
      orgId: input.orgId,
      env: input.env,
      repositoryName: binding.repositoryName,
      githubConnectionId: binding.githubConnectionId,
      pullUrl: binding.pendingConfigPullUrl,
    })
  }
  if (!branch && input.fallbackToTargetBranch) branch = binding.branch
  if (!branch) return []

  return (
    (
      await loadNotionScopeFromRepo({
        orgId: input.orgId,
        env: input.env,
        repositoryName: binding.repositoryName,
        githubConnectionId: binding.githubConnectionId,
        branch,
      })
    )?.resources ?? []
  )
}

export const notionConnectorRoutes = new OpenAPIHono<AppEnv>().openapi(
  getOAuthStartRoute,
  async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const user = c.get("user") as { id: string }
    const orgSlug = c.req.param("orgSlug")
    if (!orgSlug) return c.json({ error: "Missing org slug" }, 400)
    const env = c.var.env
    if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
      return c.json(
        {
          code: "notion_oauth_not_configured",
          error: "Notion OAuth is not configured for this ctxpipe deployment.",
        },
        503,
      )
    }
    const redirectUri = notionRedirectUri({
      baseUrl: env.AUTH_BASE_URL,
      override: env.NOTION_REDIRECT_URI,
    })
    getLogger().info("notion_oauth_start", {
      clientId: env.NOTION_CLIENT_ID,
      orgId,
      orgSlug,
      redirectUri,
      hasRedirectUriOverride: Boolean(env.NOTION_REDIRECT_URI),
    })
    const state = makeOAuthState({
      orgId,
      userId: user.id,
      orgSlug,
      secret: env.AUTH_SECRET,
    })
    return c.json(
      {
        authorizationUrl: getNotionOAuthAuthorizeUrl({
          env,
          redirectUri,
          state,
        }),
      },
      200,
    )
  },
)

export const notionOAuthCallbackRoutes = new OpenAPIHono<AppEnv>().openapi(
  getOAuthCallbackRoute,
  async (c) => {
    const user = c.get("user") as { id: string } | undefined
    if (!user) return c.json({ error: "Unauthorized" }, 401)
    const env = c.var.env
    const query = NotionOAuthCallbackQuerySchema.parse({
      code: c.req.query("code") ?? undefined,
      state: c.req.query("state") ?? undefined,
      error: c.req.query("error") ?? undefined,
    })
    const state = query.state
      ? parseOAuthState(query.state, env.AUTH_SECRET)
      : undefined
    if (query.error && state) {
      return notionSetupRelayResponse({
        orgSlug: state.orgSlug,
        error: query.error,
      })
    }
    if (query.error) {
      return c.json({ error: query.error }, 400)
    }
    if (!query.code || !query.state) {
      return c.json({ error: "Missing Notion OAuth code or state" }, 400)
    }
    if (!state || state.userId !== user.id) {
      return c.json({ error: "Invalid Notion OAuth state" }, 400)
    }
    const redirectUri = notionRedirectUri({
      baseUrl: env.AUTH_BASE_URL,
      override: env.NOTION_REDIRECT_URI,
    })
    const token = await exchangeNotionOAuthCode({
      env,
      code: query.code,
      redirectUri,
    })
    const connection = await withOrgDbContext(state.orgId, () =>
      upsertNotionConnectionFromOAuth({
        orgId: state.orgId,
        env,
        ownerUserId: user.id,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        botId: token.bot_id,
        workspaceId: token.workspace_id,
        workspaceName: token.workspace_name,
        workspaceIcon: token.workspace_icon,
      }),
    )
    return notionSetupRelayResponse({
      orgSlug: state.orgSlug,
      connectionId: connection.id,
    })
  },
)

notionConnectorRoutes
  .openapi(getStatusRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const resolved = await resolveNotionConnectionForOrgDetailed(
      orgId,
      c.var.env,
      connectionId ?? null,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_NOTION_CONNECTIONS_MESSAGE }, 400)
    }
    if (connectionId && resolved.status === "none") {
      return c.json({ error: "Unknown Notion connection" }, 404)
    }
    const connection =
      resolved.status === "ok" ? resolved.connection : undefined
    const [isGithubLinked, binding] = await Promise.all([
      orgHasAnyGithubConnection(orgId),
      connection
        ? getNotionBindingWithRepoByConnectionId(orgId, connection.id)
        : Promise.resolve(undefined),
    ])
    const resources = await loadNotionResourcesFromGit({
      orgId,
      env: c.var.env,
      binding,
    })
    return c.json(
      {
        isInstalled:
          connection?.status === "installed" && Boolean(connection.accessToken),
        installationStatus: connection?.status ?? null,
        workspaceName: connection?.workspaceName ?? null,
        isGithubLinked,
        selectedResourceCount: resources.length,
        syncTargetConfigured: Boolean(binding),
        setupPhase: binding?.setupPhase ?? "draft",
        pendingConfigPullUrl: binding?.pendingConfigPullUrl ?? null,
        pendingConfigPrCreating: binding?.pendingConfigPrCreating ?? false,
        syncTarget: binding
          ? {
              repositoryId: binding.repositoryId,
              repositoryName: binding.repositoryName,
              githubConnectionId: binding.githubConnectionId,
              branch: binding.branch,
            }
          : null,
      },
      200,
    )
  })
  .openapi(listAvailableResourcesRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const query = ConnectionIdQuerySchema.extend({
      q: z.string().optional(),
    }).parse({
      connectionId: c.req.query("connectionId") ?? undefined,
      q: c.req.query("q") ?? undefined,
    })
    const installed = await resolveInstalledNotion(
      orgId,
      c.var.env,
      query.connectionId,
    )
    if ("error" in installed) {
      return c.json({ error: installed.error }, installed.status)
    }
    const items = await searchNotionResources({
      env: c.var.env,
      connection: installed.connection,
      query: query.q,
      onTokenRefresh: async ({ accessToken, refreshToken }) => {
        await withOrgDbContext(orgId, () =>
          updateNotionConnectionTokens({
            orgId,
            connectionId: installed.connection.id,
            accessToken,
            refreshToken,
            env: c.var.env,
          }),
        )
      },
    })
    return c.json(
      {
        items: items.map((item) => ({
          externalId: item.id,
          type: item.type,
          title: item.title,
          url: item.url,
          parentExternalId: item.parentExternalId,
        })),
      },
      200,
    )
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
    const installed = await resolveInstalledNotion(
      orgId,
      c.var.env,
      connectionId,
    )
    if ("error" in installed) {
      return c.json({ error: installed.error }, installed.status)
    }
    const binding = await getNotionBindingWithRepoByConnectionId(
      orgId,
      installed.connection.id,
    )
    const resources = await loadNotionResourcesFromGit({
      orgId,
      env: c.var.env,
      binding,
    })
    return c.json(
      {
        resources: resources.map((resource) => ({
          externalId: resource.externalId,
          type: resource.type,
          title: resource.title,
          url: null,
          parentExternalId: null,
        })),
        syncTarget: binding
          ? {
              id: binding.id,
              orgId: binding.orgId,
              connectionId: binding.connectionId,
              repositoryId: binding.repositoryId,
              repositoryName: binding.repositoryName,
              githubConnectionId: binding.githubConnectionId,
              branch: binding.branch,
              enabled: binding.enabled,
              setupPhase: binding.setupPhase,
              pendingConfigPullUrl: binding.pendingConfigPullUrl ?? null,
              pendingConfigPrCreating: binding.pendingConfigPrCreating,
              createdAt: binding.createdAt.toISOString(),
              updatedAt: binding.updatedAt.toISOString(),
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
    const installed = await resolveInstalledNotion(
      orgId,
      c.var.env,
      connectionId,
    )
    if ("error" in installed) {
      return c.json({ error: installed.error }, installed.status)
    }
    const body = NotionPatchConfigRequestSchema.parse(await c.req.json())

    // Scope lives in git. Compare the requested selection against the git-native
    // scope (never Postgres) to decide whether a config PR is warranted.
    const gitResources = await loadNotionResourcesFromGit({
      orgId,
      env: c.var.env,
      binding: await getNotionBindingWithRepoByConnectionId(
        orgId,
        installed.connection.id,
      ),
      fallbackToTargetBranch: true,
    })
    const resourcesChanged =
      body.resources !== undefined &&
      !notionResourcesEqual(body.resources, gitResources)

    const saved = await patchNotionConnectorConfig({
      orgId,
      connectionId: installed.connection.id,
      ...(body.syncTarget !== undefined ? { syncTarget: body.syncTarget } : {}),
    })

    if (saved.repositoryIngestion) {
      await enqueueRepositoryIngestionWorkflow(
        {
          repositoryId: saved.repositoryIngestion.repositoryId,
          orgId: saved.repositoryIngestion.orgId,
        },
        {
          error: (err) =>
            getLogger().error(err, { step: "repositoryIngestion.enqueue" }),
        },
      )
    }

    const previousConfigPrState = resourcesChanged
      ? await claimNotionConfigPrCreation({
          connectionId: installed.connection.id,
        })
      : undefined
    const configPrEnqueued = Boolean(previousConfigPrState)
    if (previousConfigPrState && body.resources !== undefined) {
      try {
        await runWorkflowWithWorkerWake(notionSyncConfig.spec, {
          orgId,
          orgSlug: c.req.param("orgSlug"),
          connectionId: installed.connection.id,
          resources: body.resources,
        })
      } catch (err) {
        await releaseNotionConfigPrCreationClaim({
          connectionId: installed.connection.id,
          previousState: previousConfigPrState,
        })
        getLogger().error(err instanceof Error ? err : new Error(String(err)), {
          step: "notionSyncConfig.enqueue",
          connectionId: installed.connection.id,
        })
        return c.json(
          { error: "Failed to enqueue Notion configuration pull request" },
          503,
        )
      }
    }

    return c.json(
      {
        accepted: true as const,
        savedCount: body.resources?.length ?? gitResources.length,
        configPrEnqueued,
        ...(configPrEnqueued
          ? { workflowName: notionSyncConfig.spec.name }
          : {}),
      },
      200,
    )
  })
  .openapi(retryNotionConfigRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    const orgSlug = c.get("orgSlug") ?? c.req.param("orgSlug")
    if (!orgId || !orgSlug) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const installed = await resolveInstalledNotion(
      orgId,
      c.var.env,
      connectionId,
    )
    if ("error" in installed) {
      return c.json({ error: installed.error }, installed.status)
    }
    const binding = await getNotionBindingWithRepoByConnectionId(
      orgId,
      installed.connection.id,
    )
    if (binding?.setupPhase !== "config_failed") {
      return c.json(
        { error: "Notion configuration pull request is not in a failed state" },
        400,
      )
    }
    const body = z
      .object({ resources: z.array(NotionResourceSchema).optional() })
      .catch({})
      .parse(await c.req.json().catch(() => ({})))
    const gitResources = await loadNotionResourcesFromGit({
      orgId,
      env: c.var.env,
      binding,
      fallbackToTargetBranch: true,
    })
    const resources = body.resources ?? gitResources
    if (resources.length === 0) {
      return c.json(
        {
          error:
            "Notion scope is missing from the configuration PR branch; re-submit resources via PATCH or retry-config body",
        },
        400,
      )
    }
    const previousState = await claimNotionConfigPrCreation({
      connectionId: installed.connection.id,
    })
    if (!previousState) {
      return c.json(
        {
          error:
            "Notion configuration pull request creation is already in progress",
        },
        409,
      )
    }
    try {
      await runWorkflowWithWorkerWake(notionSyncConfig.spec, {
        orgId,
        orgSlug,
        connectionId: installed.connection.id,
        resources,
      })
    } catch (error) {
      await releaseNotionConfigPrCreationClaim({
        connectionId: installed.connection.id,
        previousState,
      })
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        {
          step: "notion.config_pr.retry_enqueue",
          connectionId: installed.connection.id,
        },
      )
      return c.json(
        { error: "Failed to enqueue Notion configuration pull request" },
        503,
      )
    }
    return c.json({ accepted: true as const }, 202)
  })
  .openapi(retryNotionSyncRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const installed = await resolveInstalledNotion(
      orgId,
      c.var.env,
      connectionId,
    )
    if ("error" in installed) {
      return c.json({ error: installed.error }, installed.status)
    }
    const binding = await getNotionBindingWithRepoByConnectionId(
      orgId,
      installed.connection.id,
    )
    if (!binding) {
      return c.json(
        { error: "Notion repository binding is not configured" },
        404,
      )
    }
    if (binding.setupPhase !== "sync_failed") {
      return c.json(
        { error: "Notion content sync is not in a failed state" },
        400,
      )
    }
    if (!(await claimNotionContentSyncRetry(installed.connection.id))) {
      return c.json(
        { error: "Notion content sync is already being retried" },
        409,
      )
    }
    try {
      await runWorkflowWithWorkerWake(notionSyncContent.spec, {
        orgId,
        orgSlug: c.req.param("orgSlug"),
        connectionId: installed.connection.id,
      })
    } catch (error) {
      await transitionNotionBindingState({
        connectionId: installed.connection.id,
        expectedSetupPhase: "initial_sync",
        expectedPendingConfigPrCreating: false,
        repositoryId: binding.repositoryId,
        branch: binding.branch,
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
        setupPhase: "sync_failed",
      })
      throw error
    }
    return c.json({ accepted: true as const }, 202)
  })
  .openapi(deleteNotionConnectorRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const resolved = await resolveNotionConnectionForOrgDetailed(
      orgId,
      c.var.env,
      connectionId ?? null,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_NOTION_CONNECTIONS_MESSAGE }, 400)
    }
    if (resolved.status === "none") {
      return c.json({ error: "No Notion connection found for this org" }, 404)
    }
    const ok = await deleteNotionConnectionById(orgId, resolved.connection.id)
    if (!ok)
      return c.json({ error: "No Notion connection found for this org" }, 404)
    return c.body(null, 204)
  })
