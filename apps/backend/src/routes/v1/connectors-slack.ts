import { createHmac, timingSafeEqual } from "node:crypto"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { orgHasAnyGithubConnection } from "../../models/github-installation.js"
import {
  deleteSlackConnectionById,
  listSlackChannelsByConnectionId,
  MULTIPLE_SLACK_CONNECTIONS_MESSAGE,
  resolveSlackConnectionForOrgDetailed,
  upsertSlackConnectionFromOAuth,
  getSlackSyncTargetWithRepoByConnectionId,
} from "../../models/slack-connector.js"
import { getLogger } from "../../observability/logger.js"
import {
  assertSlackOAuthConfigured,
  exchangeSlackOAuthCode,
  getSlackOAuthAuthorizeUrl,
  listSlackChannelsForBot,
} from "../../services/slack/client.js"

const ErrorResponseSchema = z
  .object({
    error: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .openapi("SlackConnectorErrorResponse")

const ConnectionIdQuerySchema = z.object({
  connectionId: z.string().min(1).optional(),
})

const SlackOAuthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
})

const SLACK_SETUP_RESULT_KEY = "slack-setup-result"

const SlackStatusResponseSchema = z
  .object({
    isInstalled: z.boolean(),
    installationStatus: z.string().nullable(),
    teamName: z.string().nullable(),
    isGithubLinked: z.boolean(),
    selectedChannelCount: z.number(),
    syncTargetConfigured: z.boolean(),
    setupPhase: z.string(),
    pendingConfigPullUrl: z.string().nullable(),
    pendingConfigPrCreating: z.boolean(),
    oldestDays: z.number().nullable(),
    syncTarget: z
      .object({
        repositoryId: z.string(),
        repositoryName: z.string(),
        branch: z.string(),
        githubConnectionId: z.string().nullable(),
      })
      .nullable(),
    selectedChannels: z.array(
      z.object({
        channelId: z.string(),
        name: z.string(),
        isPrivate: z.boolean(),
      }),
    ),
  })
  .openapi("SlackConnectorStatusResponse")

const SlackChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  isPrivate: z.boolean(),
  isMember: z.boolean(),
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
      description: "Start Slack OAuth authorization",
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
      description: "Slack OAuth not configured",
    },
  },
})

const getOAuthCallbackRoute = createRoute({
  method: "get",
  path: "/oauth/callback",
  request: { query: SlackOAuthCallbackQuerySchema },
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
      content: { "application/json": { schema: SlackStatusResponseSchema } },
      description: "Current Slack connector setup status",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple Slack connections; pass connectionId",
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

const listAvailableChannelsRoute = createRoute({
  method: "get",
  path: "/available-channels",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ items: z.array(SlackChannelSchema) }),
        },
      },
      description:
        "List Slack channels the bot is a member of (invite the bot, then refresh)",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Ambiguous connection",
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
      description: "Slack connection is not installed",
    },
  },
})

const deleteSlackConnectorRoute = createRoute({
  method: "delete",
  path: "/",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    204: { description: "Slack connector removed" },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple Slack connections; pass connectionId",
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

function slackSetupRelayPath(input: {
  orgSlug: string
  connectionId?: string
  error?: string
}) {
  const params = new URLSearchParams({ orgSlug: input.orgSlug })
  if (input.connectionId) params.set("connectionId", input.connectionId)
  if (input.error) params.set("error", input.error)
  return `/.slack/setup?${params.toString()}`
}

function slackSetupRelayResponse(input: {
  orgSlug: string
  connectionId?: string
  error?: string
}) {
  const result = {
    connectionId: input.connectionId,
    error: input.error,
  }
  const fallbackPath = slackSetupRelayPath(input)

  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Slack connected</title>
  </head>
  <body>
    <script>
      (function () {
        try {
          window.localStorage.setItem(
            ${JSON.stringify(SLACK_SETUP_RESULT_KEY)},
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

async function resolveInstalledSlack(
  orgId: string,
  connectionId?: string | null,
) {
  const resolved = await resolveSlackConnectionForOrgDetailed(
    orgId,
    connectionId,
  )
  if (resolved.status === "ambiguous") {
    return { error: MULTIPLE_SLACK_CONNECTIONS_MESSAGE, status: 400 as const }
  }
  if (resolved.status === "none") {
    return {
      error: "No Slack connection found for this org",
      status: 404 as const,
    }
  }
  if (
    resolved.connection.status !== "installed" ||
    !resolved.connection.botTokenEnc
  ) {
    return { error: "Slack connection is not installed", status: 409 as const }
  }
  return { connection: resolved.connection }
}

export const slackConnectorRoutes = new OpenAPIHono<AppEnv>().openapi(
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
    try {
      assertSlackOAuthConfigured(env)
    } catch {
      return c.json(
        {
          code: "slack_oauth_not_configured",
          error: "Slack OAuth is not configured for this ctxpipe deployment.",
        },
        503,
      )
    }
    getLogger().info("slack_oauth_start", {
      clientId: env.SLACK_CLIENT_ID,
      orgId,
      orgSlug,
      hasRedirectUriOverride: Boolean(env.SLACK_REDIRECT_URI),
    })
    const state = makeOAuthState({
      orgId,
      userId: user.id,
      orgSlug,
      secret: env.AUTH_SECRET,
    })
    return c.json(
      {
        authorizationUrl: getSlackOAuthAuthorizeUrl({ env, state }),
      },
      200,
    )
  },
)

export const slackOAuthCallbackRoutes = new OpenAPIHono<AppEnv>().openapi(
  getOAuthCallbackRoute,
  async (c) => {
    const user = c.get("user") as { id: string } | undefined
    if (!user) return c.json({ error: "Unauthorized" }, 401)
    const env = c.var.env
    const query = SlackOAuthCallbackQuerySchema.parse({
      code: c.req.query("code") ?? undefined,
      state: c.req.query("state") ?? undefined,
      error: c.req.query("error") ?? undefined,
    })
    const state = query.state
      ? parseOAuthState(query.state, env.AUTH_SECRET)
      : undefined
    if (query.error && state) {
      return slackSetupRelayResponse({
        orgSlug: state.orgSlug,
        error: query.error,
      })
    }
    if (query.error) {
      return c.json({ error: query.error }, 400)
    }
    if (!query.code || !query.state) {
      return c.json({ error: "Missing Slack OAuth code or state" }, 400)
    }
    if (!state || state.userId !== user.id) {
      return c.json({ error: "Invalid Slack OAuth state" }, 400)
    }
    const token = await exchangeSlackOAuthCode({
      env,
      code: query.code,
    })
    const teamId = token.team?.id
    const botToken = token.access_token
    if (!teamId || !botToken) {
      return c.json({ error: "Slack OAuth response missing team or token" }, 400)
    }
    const connection = await withOrgDbContext(state.orgId, () =>
      upsertSlackConnectionFromOAuth({
        orgId: state.orgId,
        env,
        ownerUserId: user.id,
        botToken,
        teamId,
        teamName: token.team?.name ?? null,
        botUserId: token.bot_user_id ?? null,
        appId: token.app_id ?? null,
      }),
    )
    return slackSetupRelayResponse({
      orgSlug: state.orgSlug,
      connectionId: connection.id,
    })
  },
)

slackConnectorRoutes
  .openapi(getStatusRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const resolved = await resolveSlackConnectionForOrgDetailed(
      orgId,
      connectionId ?? null,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_SLACK_CONNECTIONS_MESSAGE }, 400)
    }
    if (connectionId && resolved.status === "none") {
      return c.json({ error: "Unknown Slack connection" }, 404)
    }
    const connection =
      resolved.status === "ok" ? resolved.connection : undefined
    const [isGithubLinked, syncTarget, channels] = await Promise.all([
      orgHasAnyGithubConnection(orgId),
      connection
        ? getSlackSyncTargetWithRepoByConnectionId(orgId, connection.id)
        : Promise.resolve(undefined),
      connection
        ? listSlackChannelsByConnectionId(connection.id)
        : Promise.resolve([]),
    ])
    return c.json(
      {
        isInstalled:
          connection?.status === "installed" &&
          Boolean(connection.botTokenEnc),
        installationStatus: connection?.status ?? null,
        teamName: connection?.teamName ?? null,
        isGithubLinked,
        selectedChannelCount: channels.length,
        syncTargetConfigured: Boolean(syncTarget),
        setupPhase: syncTarget?.setupPhase ?? "draft",
        pendingConfigPullUrl: syncTarget?.pendingConfigPullUrl ?? null,
        pendingConfigPrCreating: syncTarget?.pendingConfigPrCreating ?? false,
        oldestDays: syncTarget?.oldestDays ?? null,
        syncTarget: syncTarget
          ? {
              repositoryId: syncTarget.repositoryId,
              repositoryName: syncTarget.repositoryName,
              githubConnectionId: syncTarget.githubConnectionId,
              branch: syncTarget.branch,
            }
          : null,
        selectedChannels: channels.map((channel) => ({
          channelId: channel.channelId,
          name: channel.name,
          isPrivate: channel.isPrivate,
        })),
      },
      200,
    )
  })
  .openapi(listAvailableChannelsRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const installed = await resolveInstalledSlack(orgId, connectionId ?? null)
    if ("error" in installed) {
      return c.json({ error: installed.error }, installed.status)
    }
    const items = await listSlackChannelsForBot({
      env: c.var.env,
      connection: installed.connection,
    })
    return c.json({ items }, 200)
  })
  .openapi(deleteSlackConnectorRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = ConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const resolved = await resolveSlackConnectionForOrgDetailed(
      orgId,
      connectionId ?? null,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_SLACK_CONNECTIONS_MESSAGE }, 400)
    }
    if (resolved.status === "none") {
      return c.json({ error: "Unknown Slack connection" }, 404)
    }
    await deleteSlackConnectionById(orgId, resolved.connection.id)
    return c.body(null, 204)
  })
