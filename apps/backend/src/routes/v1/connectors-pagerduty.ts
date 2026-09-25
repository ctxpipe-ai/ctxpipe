import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { hasOrgAdminOrOwnerRole } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  envHasPagerdutyOAuthApp,
  resolvePagerdutyOAuthAppCreds,
} from "../../lib/connection-config.js"
import { orgHasAnyGithubConnection } from "../../models/github-installation.js"
import {
  claimPagerdutyConfigPrCreation,
  claimPagerdutyContentSyncRetry,
  createOrReusePagerdutyDraft,
  deletePagerdutyConnectionById,
  getPagerdutyBindingWithRepoByConnectionId,
  getPagerdutyConnectionByConnectionId,
  MULTIPLE_PAGERDUTY_CONNECTIONS_MESSAGE,
  type PagerdutyBindingWithRepo,
  type PagerdutyConnection,
  pagerdutyOAuthAppMetadata,
  patchPagerdutyConnectorConfig,
  persistPagerdutyWebhookSubscriptionIfAbsent,
  recordPagerdutyOAuthRevocation,
  refreshPagerdutyConnectionTokensWithLock,
  releasePagerdutyConfigPrCreationClaim,
  resolvePagerdutyConnectionForOrgDetailed,
  savePagerdutyOAuthApp,
  transitionPagerdutyBindingState,
  upsertPagerdutyConnectionFromOAuth,
} from "../../models/pagerduty-connector.js"
import { getLogger } from "../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../openworkflow/client.js"
import { enqueueRepositoryIngestionWorkflow } from "../../openworkflow/enqueue-repository-ingestion.js"
import { pagerdutySyncConfig } from "../../openworkflow/workflows/pagerduty-sync-config.js"
import { pagerdutySyncContent } from "../../openworkflow/workflows/pagerduty-sync-content.js"
import { getPullRequestHeadBranch } from "../../services/github/installation-write-client.js"
import {
  createPagerdutyPkcePair,
  deletePagerdutyWebhookSubscription,
  ensurePagerdutyWebhookSubscription,
  exchangePagerdutyOAuthCode,
  getPagerdutyAccountIdentity,
  getPagerdutyOAuthAuthorizeUrl,
  isPagerdutyAuthorizationRevokedError,
  listPagerdutyServices,
  pagerdutyWebhookDeliveryUrl,
  refreshPagerdutyOAuthToken,
} from "../../services/pagerduty/client.js"
import { loadPagerdutyScopeFromRepo } from "../../services/pagerduty/config-from-repo.js"
import {
  type PagerdutyConfigService,
  pagerdutyServicesEqual,
} from "../../services/pagerduty/config-yaml.js"
import {
  createPagerdutyOAuthState,
  expirePagerdutyPkceCookieHeader,
  pagerdutyPkceCookieFromHeader,
  pagerdutyPkceCookieHeader,
  serializePagerdutyPkceCookie,
  verifyPagerdutyOAuthState,
} from "../../services/pagerduty/oauth-state.js"

const ErrorResponseSchema = z.object({ error: z.string() })
const ConnectionIdQuerySchema = z.object({
  connectionId: z.string().min(1).optional(),
})
const PagerdutyOAuthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  state: z.string().optional(),
})

const PagerdutyServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url().optional(),
})

const PagerdutyConnectionBindingSchema = z
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

const PagerdutyPatchConfigRequestSchema = z
  .object({
    services: z.array(PagerdutyServiceSchema).optional(),
    syncTarget: PagerdutyConnectionBindingSchema.optional(),
  })
  .refine(
    (body) => body.services !== undefined || body.syncTarget !== undefined,
    { message: "Provide services or syncTarget" },
  )

const PagerdutyOAuthAppPutSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
})

const RequiredConnectionIdQuerySchema = z.object({
  connectionId: z.string().min(1),
})

const getOAuthStartRoute = createRoute({
  method: "get",
  path: "/oauth/start",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ authorizationUrl: z.string().url() }),
        },
      },
      description: "Start PagerDuty OAuth authorization",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown PagerDuty connection",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "PagerDuty OAuth not configured",
    },
  },
})

const postSetupRoute = createRoute({
  method: "post",
  path: "/setup",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ connectionId: z.string().min(1).nullable() }),
        },
      },
      description: "Start hosted or self-hosted PagerDuty setup",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

const putOAuthAppRoute = createRoute({
  method: "put",
  path: "/oauth-app",
  request: {
    query: RequiredConnectionIdQuerySchema,
    body: {
      content: { "application/json": { schema: PagerdutyOAuthAppPutSchema } },
    },
  },
  responses: {
    204: {
      description: "Saved PagerDuty OAuth app on the connection",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid PagerDuty OAuth app credentials",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown PagerDuty connection",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "OAuth app is already bound to authorised tokens",
    },
  },
})

const getOAuthCallbackRoute = createRoute({
  method: "get",
  path: "/callback",
  request: { query: PagerdutyOAuthCallbackQuerySchema },
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

const PagerdutyStatusResponseSchema = z.object({
  isInstalled: z.boolean(),
  installationStatus: z.string().nullable(),
  accountName: z.string().nullable(),
  accountSubdomain: z.string().nullable(),
  region: z.enum(["us", "eu"]).nullable(),
  isGithubLinked: z.boolean(),
  selectedServiceCount: z.number().nullable(),
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
  oauthAppSaved: z.boolean(),
  globalPagerdutyOAuthConfigured: z.boolean(),
  oauthCallbackUrl: z.string(),
})

const getStatusRoute = createRoute({
  method: "get",
  path: "/status",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: PagerdutyStatusResponseSchema },
      },
      description: "Current PagerDuty connector setup status",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple PagerDuty connections; pass connectionId",
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

const listAvailableServicesRoute = createRoute({
  method: "get",
  path: "/available-services",
  request: {
    query: ConnectionIdQuerySchema.extend({
      q: z.string().optional(),
      offset: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(PagerdutyServiceSchema),
            more: z.boolean(),
          }),
        },
      },
      description: "Page PagerDuty services for scope selection",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple PagerDuty connections; pass connectionId",
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

const getConfigRoute = createRoute({
  method: "get",
  path: "/config",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            services: z.array(PagerdutyServiceSchema),
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
      description: "PagerDuty scope from git and repository binding",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
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
        "application/json": { schema: PagerdutyPatchConfigRequestSchema },
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
      description: "Saved PagerDuty binding and/or enqueued config PR",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid or ambiguous PagerDuty configuration",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown PagerDuty connection",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Failed to enqueue configuration pull request",
    },
  },
})

const retryPagerdutyConfigRoute = createRoute({
  method: "post",
  path: "/retry-config",
  request: {
    query: ConnectionIdQuerySchema,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              services: z.array(PagerdutyServiceSchema).optional(),
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
      description: "Configuration pull request retry accepted",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not in a failed configuration state",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown PagerDuty connection",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Configuration pull request already in progress",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Failed to enqueue configuration pull request",
    },
  },
})

const retryPagerdutySyncRoute = createRoute({
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
      description: "Content sync retry accepted",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not in a failed content sync state",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown or incomplete PagerDuty connection",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Content sync already being retried",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Failed to enqueue content sync retry",
    },
  },
})

const deletePagerdutyConnectorRoute = createRoute({
  method: "delete",
  path: "/",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    204: { description: "PagerDuty connection removed" },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Ambiguous PagerDuty connection",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No PagerDuty connection found",
    },
  },
})

function setupRelayResponse(input: {
  origin: string
  orgSlug: string
  result:
    | { type: "pagerduty-oauth-complete"; connectionId: string }
    | { type: "pagerduty-oauth-error"; error: string }
  extraHeaders?: Record<string, string>
}): Response {
  const payload = JSON.stringify({
    orgSlug: input.orgSlug,
    ...input.result,
  }).replaceAll("<", "\\u003c")
  const origin = JSON.stringify(input.origin)
  const connected = input.result.type === "pagerduty-oauth-complete"
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${connected ? "PagerDuty connected" : "PagerDuty authorization failed"}</title><script>const result=${payload};try{window.opener?.postMessage(result,${origin});localStorage.setItem("pagerduty-setup-result",JSON.stringify(result))}finally{window.close()}</script><p>${connected ? "PagerDuty connected." : "PagerDuty authorization failed."} You can close this window.</p>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...input.extraHeaders,
      },
    },
  )
}

async function resolveInstalledPagerduty(
  orgId: string,
  env: AppEnv["Variables"]["env"],
  connectionId?: string,
): Promise<
  | { status: "ok"; connection: PagerdutyConnection }
  | { status: "error"; error: string; httpStatus: 400 | 404 }
> {
  const resolved = await resolvePagerdutyConnectionForOrgDetailed(
    orgId,
    env,
    connectionId,
  )
  if (resolved.status === "ambiguous") {
    return {
      status: "error",
      error: MULTIPLE_PAGERDUTY_CONNECTIONS_MESSAGE,
      httpStatus: 400,
    }
  }
  if (resolved.status === "none") {
    return {
      status: "error",
      error: "Unknown PagerDuty connection",
      httpStatus: 404,
    }
  }
  if (resolved.connection.status !== "installed") {
    return {
      status: "error",
      error: "PagerDuty authorization is revoked; reconnect the account",
      httpStatus: 400,
    }
  }
  return { status: "ok", connection: resolved.connection }
}

async function loadPagerdutyServicesFromGit(input: {
  orgId: string
  env: AppEnv["Variables"]["env"]
  binding: PagerdutyBindingWithRepo | undefined
  fallbackToTargetBranch?: boolean
}): Promise<PagerdutyConfigService[]> {
  const { binding } = input
  if (!binding?.githubConnectionId) return []

  let branch: string | undefined
  if (
    binding.setupPhase === "live" ||
    binding.setupPhase === "initial_sync" ||
    binding.setupPhase === "sync_failed"
  ) {
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
      await loadPagerdutyScopeFromRepo({
        orgId: input.orgId,
        env: input.env,
        repositoryName: binding.repositoryName,
        githubConnectionId: binding.githubConnectionId,
        branch,
      })
    )?.services ?? []
  )
}

function pagerdutyCookieSecure(env: AppEnv["Variables"]["env"]): boolean {
  return env.AUTH_BASE_URL.startsWith("https://")
}

function resolvePagerdutyCredsForConnection(
  connection: PagerdutyConnection | undefined,
  env: AppEnv["Variables"]["env"],
) {
  return resolvePagerdutyOAuthAppCreds(connection, env)
}

function pagerdutyTokenRefresh(
  orgId: string,
  connection: PagerdutyConnection,
  env: AppEnv["Variables"]["env"],
) {
  return async (expectedRefreshToken: string, expectedAccessToken: string) => {
    try {
      return await withOrgDbContext(orgId, () =>
        refreshPagerdutyConnectionTokensWithLock({
          orgId,
          connectionId: connection.id,
          env,
          expectedRefreshToken,
          expectedAccessToken,
          refresh: async (refreshToken) => {
            const creds = resolvePagerdutyOAuthAppCreds(connection, env)
            if (!creds) {
              throw new Error("PagerDuty OAuth is not configured")
            }
            return refreshPagerdutyOAuthToken({ env, creds, refreshToken })
          },
        }),
      )
    } catch (error) {
      if (isPagerdutyAuthorizationRevokedError(error)) {
        await withOrgDbContext(orgId, () =>
          recordPagerdutyOAuthRevocation({
            orgId,
            connectionId: connection.id,
            env,
            expectedAccessToken,
          }),
        )
      }
      throw error
    }
  }
}

export const pagerdutyConnectorRoutes = new OpenAPIHono<AppEnv>()
  .openapi(postSetupRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    const orgId = c.get("orgId")
    if (!user || !session || !orgId) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    if (envHasPagerdutyOAuthApp(c.var.env)) {
      return c.json({ connectionId: null }, 200)
    }
    const connection = await createOrReusePagerdutyDraft({
      orgId,
      env: c.var.env,
      ownerUserId: user.id,
    })
    return c.json({ connectionId: connection.id }, 200)
  })
  .openapi(putOAuthAppRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = RequiredConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId"),
    })
    const body = PagerdutyOAuthAppPutSchema.parse(await c.req.json())
    try {
      await savePagerdutyOAuthApp({
        orgId,
        connectionId,
        env: c.var.env,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
      })
      return c.body(null, 204)
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      if (message === "PagerDuty connection not found") {
        return c.json({ error: "Unknown PagerDuty connection" }, 404)
      }
      if (message.includes("cannot be changed after account authorisation")) {
        return c.json({ error: message }, 409)
      }
      throw error
    }
  })
  .openapi(getOAuthStartRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    const orgId = c.get("orgId")
    const orgSlug = c.get("orgSlug") ?? c.req.param("orgSlug")
    if (!user || !session || !orgId || !orgSlug) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const env = c.var.env
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const connection = connectionId
      ? await getPagerdutyConnectionByConnectionId(orgId, connectionId, env)
      : undefined
    if (connectionId && !connection) {
      return c.json({ error: "Unknown PagerDuty connection" }, 404)
    }
    const creds = resolvePagerdutyCredsForConnection(connection, env)
    if (!creds) {
      return c.json({ error: "PagerDuty OAuth is not configured" }, 503)
    }
    const { codeVerifier, codeChallenge } = createPagerdutyPkcePair()
    const { state, nonce } = createPagerdutyOAuthState({
      authSecret: env.AUTH_SECRET,
      orgId,
      orgSlug,
      userId: user.id,
      connectionId: connection?.id,
    })
    c.header(
      "Set-Cookie",
      pagerdutyPkceCookieHeader(
        serializePagerdutyPkceCookie({ nonce, codeVerifier }),
        pagerdutyCookieSecure(env),
      ),
    )
    return c.json(
      {
        authorizationUrl: getPagerdutyOAuthAuthorizeUrl({
          env,
          creds,
          state,
          codeChallenge,
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
    const resolved = await resolvePagerdutyConnectionForOrgDetailed(
      orgId,
      c.var.env,
      connectionId,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_PAGERDUTY_CONNECTIONS_MESSAGE }, 400)
    }
    if (connectionId && resolved.status === "none") {
      return c.json({ error: "Unknown PagerDuty connection" }, 404)
    }
    const connection =
      resolved.status === "ok" ? resolved.connection : undefined
    const oauth = pagerdutyOAuthAppMetadata(connection, c.var.env)
    const [isGithubLinked, binding] = await Promise.all([
      orgHasAnyGithubConnection(orgId),
      connection
        ? getPagerdutyBindingWithRepoByConnectionId(orgId, connection.id)
        : Promise.resolve(undefined),
    ])
    return c.json(
      {
        isInstalled: connection?.status === "installed",
        installationStatus: connection?.status ?? null,
        accountName: connection?.accountName ?? null,
        accountSubdomain: connection?.accountSubdomain ?? null,
        region: connection?.region ?? null,
        isGithubLinked,
        selectedServiceCount: null,
        setupPhase: binding?.setupPhase ?? "draft",
        pendingConfigPullUrl: binding?.pendingConfigPullUrl ?? null,
        pendingConfigPrCreating: binding?.pendingConfigPrCreating ?? false,
        syncTargetConfigured: Boolean(binding),
        syncTarget: binding
          ? {
              repositoryId: binding.repositoryId,
              repositoryName: binding.repositoryName,
              githubConnectionId: binding.githubConnectionId,
              branch: binding.branch,
            }
          : null,
        oauthAppSaved: oauth.oauthAppSaved,
        globalPagerdutyOAuthConfigured: oauth.globalPagerdutyOAuthConfigured,
        oauthCallbackUrl: oauth.oauthCallbackUrl,
      },
      200,
    )
  })
  .openapi(listAvailableServicesRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const query = ConnectionIdQuerySchema.extend({
      q: z.string().optional(),
      offset: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).parse({
      connectionId: c.req.query("connectionId") ?? undefined,
      q: c.req.query("q") ?? undefined,
      offset: c.req.query("offset") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
    })
    const installed = await resolveInstalledPagerduty(
      orgId,
      c.var.env,
      query.connectionId,
    )
    if (installed.status === "error") {
      return c.json({ error: installed.error }, installed.httpStatus)
    }
    if (!installed.connection.accessToken) {
      return c.json(
        { error: "PagerDuty authorization is revoked; reconnect the account" },
        400,
      )
    }
    if (installed.connection.refreshToken) {
      const expiresAt = installed.connection.accessTokenExpiresAt
      if (!expiresAt || Date.parse(expiresAt) - 60_000 <= Date.now()) {
        const refreshed = await pagerdutyTokenRefresh(
          orgId,
          installed.connection,
          c.var.env,
        )(installed.connection.refreshToken, installed.connection.accessToken)
        installed.connection.accessToken = refreshed.accessToken
        installed.connection.refreshToken = refreshed.refreshToken
        installed.connection.accessTokenExpiresAt =
          refreshed.accessTokenExpiresAt
      }
    }
    if (!installed.connection.accessToken) {
      return c.json(
        { error: "PagerDuty authorization is revoked; reconnect the account" },
        400,
      )
    }
    const page = await listPagerdutyServices({
      accessToken: installed.connection.accessToken,
      region: installed.connection.region,
      query: query.q,
      offset: query.offset,
      limit: query.limit,
    })
    return c.json({ items: page.services, more: page.more }, 200)
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
    const installed = await resolveInstalledPagerduty(
      orgId,
      c.var.env,
      connectionId,
    )
    if (installed.status === "error") {
      return c.json({ error: installed.error }, installed.httpStatus)
    }
    const binding = await getPagerdutyBindingWithRepoByConnectionId(
      orgId,
      installed.connection.id,
    )
    const services = await loadPagerdutyServicesFromGit({
      orgId,
      env: c.var.env,
      binding,
    })
    return c.json(
      {
        services,
        syncTarget: binding
          ? {
              repositoryId: binding.repositoryId,
              repositoryName: binding.repositoryName,
              githubConnectionId: binding.githubConnectionId,
              branch: binding.branch,
              enabled: binding.enabled,
              setupPhase: binding.setupPhase,
              pendingConfigPullUrl: binding.pendingConfigPullUrl,
              pendingConfigPrCreating: binding.pendingConfigPrCreating,
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
    const installed = await resolveInstalledPagerduty(
      orgId,
      c.var.env,
      connectionId,
    )
    if (installed.status === "error") {
      return c.json({ error: installed.error }, installed.httpStatus)
    }
    const body = PagerdutyPatchConfigRequestSchema.parse(await c.req.json())
    const binding = await getPagerdutyBindingWithRepoByConnectionId(
      orgId,
      installed.connection.id,
    )
    const gitServices = await loadPagerdutyServicesFromGit({
      orgId,
      env: c.var.env,
      binding,
      fallbackToTargetBranch: true,
    })
    const servicesMatch =
      body.services !== undefined &&
      pagerdutyServicesEqual(body.services, gitServices)
    const shouldStartInitialSync =
      servicesMatch &&
      binding?.enabled === true &&
      binding.setupPhase === "draft"
    // A matching live scope is a no-op. A matching rebound draft skips the PR
    // but still needs its initial content sync.
    const servicesChanged = body.services !== undefined && !servicesMatch

    const saved = await patchPagerdutyConnectorConfig({
      orgId,
      connectionId: installed.connection.id,
      ...(body.syncTarget !== undefined ? { syncTarget: body.syncTarget } : {}),
    })

    if (saved.repositoryIngestion) {
      await enqueueRepositoryIngestionWorkflow(
        {
          repositoryId: saved.repositoryIngestion.repositoryId,
          orgId: saved.repositoryIngestion.orgId,
          ...(saved.repositoryIngestion.targetBranch !== undefined
            ? { targetBranch: saved.repositoryIngestion.targetBranch }
            : {}),
        },
        {
          error: (err) =>
            getLogger().error(err, { step: "repositoryIngestion.enqueue" }),
        },
      )
    }

    const previousConfigPrState = servicesChanged
      ? await claimPagerdutyConfigPrCreation({
          connectionId: installed.connection.id,
        })
      : undefined
    const configPrEnqueued = Boolean(previousConfigPrState)
    if (previousConfigPrState && body.services !== undefined) {
      try {
        await runWorkflowWithWorkerWake(pagerdutySyncConfig.spec, {
          orgId,
          orgSlug,
          connectionId: installed.connection.id,
          services: body.services,
        })
      } catch (err) {
        await releasePagerdutyConfigPrCreationClaim({
          connectionId: installed.connection.id,
          previousState: previousConfigPrState,
        })
        getLogger().error(err instanceof Error ? err : new Error(String(err)), {
          step: "pagerdutySyncConfig.enqueue",
          connectionId: installed.connection.id,
        })
        return c.json(
          { error: "Failed to enqueue PagerDuty configuration pull request" },
          503,
        )
      }
    }

    if (shouldStartInitialSync && binding) {
      const claimed = await transitionPagerdutyBindingState({
        connectionId: installed.connection.id,
        expectedSetupPhase: "draft",
        expectedPendingConfigPrCreating: false,
        repositoryId: binding.repositoryId,
        branch: binding.branch,
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
        setupPhase: "initial_sync",
      })
      if (!claimed) {
        return c.json(
          {
            error: "PagerDuty sync target changed while starting initial sync",
          },
          409,
        )
      }
      try {
        await runWorkflowWithWorkerWake(pagerdutySyncContent.spec, {
          orgId,
          connectionId: installed.connection.id,
        })
      } catch (error) {
        await transitionPagerdutyBindingState({
          connectionId: installed.connection.id,
          expectedSetupPhase: "initial_sync",
          expectedPendingConfigPrCreating: false,
          repositoryId: binding.repositoryId,
          branch: binding.branch,
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          setupPhase: "sync_failed",
        })
        getLogger().error(
          error instanceof Error ? error : new Error(String(error)),
          {
            step: "pagerduty.initial_sync.enqueue",
            connectionId: installed.connection.id,
          },
        )
        return c.json(
          { error: "Failed to enqueue PagerDuty initial sync" },
          503,
        )
      }
    }

    return c.json(
      {
        accepted: true as const,
        savedCount: body.services?.length ?? gitServices.length,
        configPrEnqueued,
        ...(configPrEnqueued
          ? { workflowName: pagerdutySyncConfig.spec.name }
          : {}),
      },
      200,
    )
  })
  .openapi(retryPagerdutyConfigRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    const orgSlug = c.get("orgSlug") ?? c.req.param("orgSlug")
    if (!orgId || !orgSlug) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const installed = await resolveInstalledPagerduty(
      orgId,
      c.var.env,
      connectionId,
    )
    if (installed.status === "error") {
      return c.json({ error: installed.error }, installed.httpStatus)
    }
    const binding = await getPagerdutyBindingWithRepoByConnectionId(
      orgId,
      installed.connection.id,
    )
    if (binding?.setupPhase !== "config_failed") {
      return c.json(
        {
          error:
            "PagerDuty configuration pull request is not in a failed state",
        },
        400,
      )
    }
    const body = z
      .object({ services: z.array(PagerdutyServiceSchema).optional() })
      .catch({})
      .parse(await c.req.json().catch(() => ({})))
    const gitServices = await loadPagerdutyServicesFromGit({
      orgId,
      env: c.var.env,
      binding,
      fallbackToTargetBranch: true,
    })
    const services = body.services ?? gitServices
    if (services.length === 0) {
      return c.json(
        {
          error:
            "PagerDuty scope is missing from the configuration PR branch; re-submit services via PATCH or retry-config body",
        },
        400,
      )
    }
    const previousState = await claimPagerdutyConfigPrCreation({
      connectionId: installed.connection.id,
    })
    if (!previousState) {
      return c.json(
        {
          error:
            "PagerDuty configuration pull request creation is already in progress",
        },
        409,
      )
    }
    try {
      await runWorkflowWithWorkerWake(pagerdutySyncConfig.spec, {
        orgId,
        orgSlug,
        connectionId: installed.connection.id,
        services,
      })
    } catch (error) {
      await releasePagerdutyConfigPrCreationClaim({
        connectionId: installed.connection.id,
        previousState,
      })
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        {
          step: "pagerduty.config_pr.retry_enqueue",
          connectionId: installed.connection.id,
        },
      )
      return c.json(
        { error: "Failed to enqueue PagerDuty configuration pull request" },
        503,
      )
    }
    return c.json({ accepted: true as const }, 202)
  })
  .openapi(retryPagerdutySyncRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const installed = await resolveInstalledPagerduty(
      orgId,
      c.var.env,
      connectionId,
    )
    if (installed.status === "error") {
      return c.json({ error: installed.error }, installed.httpStatus)
    }
    const binding = await getPagerdutyBindingWithRepoByConnectionId(
      orgId,
      installed.connection.id,
    )
    if (!binding) {
      return c.json(
        { error: "PagerDuty repository binding is not configured" },
        404,
      )
    }
    if (binding.setupPhase !== "sync_failed") {
      return c.json(
        { error: "PagerDuty content sync is not in a failed state" },
        400,
      )
    }
    if (!(await claimPagerdutyContentSyncRetry(installed.connection.id))) {
      return c.json(
        { error: "PagerDuty content sync is already being retried" },
        409,
      )
    }
    try {
      await runWorkflowWithWorkerWake(pagerdutySyncContent.spec, {
        orgId,
        connectionId: installed.connection.id,
      })
    } catch (error) {
      await transitionPagerdutyBindingState({
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
  .openapi(deletePagerdutyConnectorRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const resolved = await resolvePagerdutyConnectionForOrgDetailed(
      orgId,
      c.var.env,
      connectionId,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_PAGERDUTY_CONNECTIONS_MESSAGE }, 400)
    }
    if (resolved.status === "none") {
      return c.json(
        { error: "No PagerDuty connection found for this org" },
        404,
      )
    }
    if (
      resolved.connection.webhookSubscriptionId &&
      resolved.connection.accessToken
    ) {
      try {
        await deletePagerdutyWebhookSubscription({
          accessToken: resolved.connection.accessToken,
          region: resolved.connection.region,
          subscriptionId: resolved.connection.webhookSubscriptionId,
        })
      } catch (error) {
        getLogger().error(
          error instanceof Error ? error : new Error(String(error)),
          {
            step: "pagerdutyWebhookSubscription.delete",
            connectionId: resolved.connection.id,
          },
        )
      }
    }
    const deleted = await deletePagerdutyConnectionById(
      orgId,
      resolved.connection.id,
    )
    return deleted
      ? c.body(null, 204)
      : c.json({ error: "No PagerDuty connection found for this org" }, 404)
  })

export const pagerdutyOauthCallbackRoutes = new OpenAPIHono<AppEnv>().openapi(
  getOAuthCallbackRoute,
  async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)
    const query = PagerdutyOAuthCallbackQuerySchema.parse({
      code: c.req.query("code") ?? undefined,
      error: c.req.query("error") ?? undefined,
      state: c.req.query("state") ?? undefined,
    })
    if (!query.state) {
      return c.json({ error: "Missing PagerDuty OAuth state" }, 400)
    }
    const state = verifyPagerdutyOAuthState({
      authSecret: c.var.env.AUTH_SECRET,
      state: query.state,
    })
    if (!state || state.userId !== user.id) {
      return c.json({ error: "Invalid PagerDuty OAuth state" }, 400)
    }
    const origin = new URL(c.var.env.AUTH_BASE_URL).origin
    const expireCookie = expirePagerdutyPkceCookieHeader(
      pagerdutyCookieSecure(c.var.env),
    )
    const relayError = (error: string) =>
      setupRelayResponse({
        origin,
        orgSlug: state.orgSlug,
        result: { type: "pagerduty-oauth-error", error },
        extraHeaders: { "Set-Cookie": expireCookie },
      })
    if (query.error) {
      return relayError(`PagerDuty authorization failed: ${query.error}`)
    }
    if (!query.code) {
      return c.json({ error: "Missing PagerDuty OAuth code" }, 400)
    }
    const codeVerifier = pagerdutyPkceCookieFromHeader(
      c.req.header("cookie"),
      state.nonce,
    )
    if (!codeVerifier) {
      return c.json({ error: "Missing PagerDuty PKCE verifier" }, 400)
    }
    if (
      !(await hasOrgAdminOrOwnerRole({
        headers: c.req.raw.headers,
        orgId: state.orgId,
      }))
    ) {
      return relayError(
        "You no longer have permission to connect PagerDuty to this organisation",
      )
    }

    try {
      const draft = state.connectionId
        ? await withOrgDbContext(state.orgId, () =>
            getPagerdutyConnectionByConnectionId(
              state.orgId,
              state.connectionId ?? "",
              c.var.env,
            ),
          )
        : undefined
      if (state.connectionId && !draft) {
        return relayError(
          "PagerDuty connection was removed before authorisation completed",
        )
      }
      const creds = resolvePagerdutyCredsForConnection(draft, c.var.env)
      if (!creds) {
        return relayError("PagerDuty OAuth is not configured")
      }
      const token = await exchangePagerdutyOAuthCode({
        env: c.var.env,
        creds,
        code: query.code,
        codeVerifier,
      })
      const identity = await getPagerdutyAccountIdentity({
        accessToken: token.accessToken,
      })
      const connection = await withOrgDbContext(state.orgId, () =>
        upsertPagerdutyConnectionFromOAuth({
          orgId: state.orgId,
          env: c.var.env,
          ownerUserId: user.id,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          accessTokenExpiresAt: token.accessTokenExpiresAt,
          accountId: identity.accountId,
          accountName: identity.accountName,
          accountSubdomain: identity.accountSubdomain,
          region: identity.region,
          actorUserId: identity.actorUserId,
          oauthApp: creds,
          connectionId: state.connectionId,
        }),
      )
      if (!connection.webhookSubscriptionId || !connection.webhookSecretEnc) {
        const webhook = await ensurePagerdutyWebhookSubscription({
          accessToken: token.accessToken,
          region: identity.region,
          deliveryUrl: pagerdutyWebhookDeliveryUrl(c.var.env),
          existingSubscriptionId: connection.webhookSubscriptionId,
          hasStoredSecret: Boolean(connection.webhookSecretEnc),
        })
        if ("reused" in webhook) {
          throw new Error(
            "PagerDuty reused a webhook without a stored signing secret",
          )
        }
        const cleanupWebhook = async () => {
          try {
            await deletePagerdutyWebhookSubscription({
              accessToken: token.accessToken,
              region: identity.region,
              subscriptionId: webhook.id,
            })
          } catch (cleanupError) {
            getLogger().warn("pagerduty_oauth_webhook_cleanup_failed", {
              connectionId: connection.id,
              webhookSubscriptionId: webhook.id,
              error:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
            })
          }
        }
        try {
          const retainedSubscriptionId = await withOrgDbContext(
            state.orgId,
            () =>
              persistPagerdutyWebhookSubscriptionIfAbsent({
                orgId: state.orgId,
                connectionId: connection.id,
                env: c.var.env,
                webhookSubscriptionId: webhook.id,
                webhookSecret: webhook.secret,
              }),
          )
          if (retainedSubscriptionId !== webhook.id) await cleanupWebhook()
        } catch (error) {
          await cleanupWebhook()
          throw error
        }
      }
      return setupRelayResponse({
        origin,
        orgSlug: state.orgSlug,
        result: {
          type: "pagerduty-oauth-complete",
          connectionId: connection.id,
        },
        extraHeaders: { "Set-Cookie": expireCookie },
      })
    } catch (error) {
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "pagerduty.oauth_callback" },
      )
      const message = error instanceof Error ? error.message : ""
      return relayError(
        message.startsWith("PagerDuty ")
          ? message
          : "PagerDuty authorization could not be completed. Close this window and try again.",
      )
    }
  },
)
