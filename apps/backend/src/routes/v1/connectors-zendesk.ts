import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { hasOrgAdminOrOwnerRole } from "../../auth/withAuth.js"
import { formatUnknownError } from "../../db/transientDbRetry.js"
import {
  createZendeskDraft,
  deleteZendeskConnection,
  getZendeskConnection,
  saveZendeskOAuthClient,
  saveZendeskTokens,
  saveZendeskWebhook,
  type ZendeskConnection,
} from "../../models/zendesk-connector.js"
import { getLogger } from "../../observability/logger.js"
import {
  freshZendeskAccessToken,
  loggableZendeskError,
} from "../../services/zendesk/access-token.js"
import {
  createZendeskArticleWebhook,
  deleteZendeskWebhook,
  listZendeskCategories,
  listZendeskViews,
  revokeZendeskAccessToken,
} from "../../services/zendesk/client.js"
import {
  createZendeskOAuthState,
  createZendeskPkcePair,
  exchangeZendeskCode,
  isZendeskSubdomain,
  verifyZendeskOAuthState,
  ZendeskAuthorizationRevokedError,
  zendeskAuthorizeUrl,
  zendeskPkceCookieHeader,
  zendeskPkceVerifierFromCookie,
  zendeskRedirectUri,
} from "../../services/zendesk/oauth.js"

const ErrorResponseSchema = z.object({ error: z.string() })
const ConnectionIdQuerySchema = z.object({ connectionId: z.string().min(1) })
const error = (description: string) => ({
  content: { "application/json": { schema: ErrorResponseSchema } },
  description,
})
const UNKNOWN_CONNECTION = "Unknown Zendesk connection"
const RECONNECT_MESSAGE =
  "Zendesk does not accept the authorization of this connection. Reconnect Zendesk."

const draftRoute = createRoute({
  method: "post",
  path: "/",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            subdomain: z
              .string()
              .trim()
              .toLowerCase()
              .refine(
                isZendeskSubdomain,
                "Use the subdomain, for example acme",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ connectionId: z.string() }) },
      },
      description: "A pending setup for the subdomain",
    },
    401: error("Unauthorized"),
  },
})

const oauthClientRoute = createRoute({
  method: "put",
  path: "/oauth-client",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            connectionId: z.string().min(1),
            clientId: z.string().trim().min(1),
            clientSecret: z.string().trim().min(1),
          }),
        },
      },
    },
  },
  responses: {
    204: { description: "The local OAuth client is saved on the connection" },
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
  },
})

const oauthStartRoute = createRoute({
  method: "get",
  path: "/oauth/start",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ authorizationUrl: z.string() }),
        },
      },
      description: "The Zendesk authorization URL; sets the PKCE cookie",
    },
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
    409: error("No OAuth client for this connection"),
  },
})

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(["pending", "installed", "revoked"]),
            subdomain: z.string(),
            /** The row or the deployment has an OAuth client. */
            oauthClientConfigured: z.boolean(),
            /** The deployment has a global OAuth client (hosted). */
            deploymentOAuthClient: z.boolean(),
            /** Register this redirect URL on a local OAuth client. */
            redirectUri: z.string(),
            webhookConfigured: z.boolean(),
          }),
        },
      },
      description: "The Zendesk connection, without secrets",
    },
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
  },
})

const catalogRoute = createRoute({
  method: "get",
  path: "/catalog",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            categories: z.array(z.object({ id: z.string(), name: z.string() })),
            views: z.array(z.object({ id: z.string(), title: z.string() })),
          }),
        },
      },
      description: "The categories and active views, for the scope picker",
    },
    400: error(RECONNECT_MESSAGE),
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
  },
})

const deleteRoute = createRoute({
  method: "delete",
  path: "/",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    204: { description: "The connection and its Zendesk webhook are removed" },
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
  },
})

const callbackRoute = createRoute({
  method: "get",
  path: "/callback",
  request: {
    query: z.object({
      code: z.string().optional(),
      error: z.string().optional(),
      state: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Relay the OAuth result to the setup window" },
    400: error("Invalid OAuth callback"),
    401: error("Unauthorized"),
    403: error("An API key cannot connect Zendesk"),
  },
})

const cookieSecure = (env: AppEnv["Variables"]["env"]) =>
  env.AUTH_BASE_URL.startsWith("https://")

/** A usable token, or null when Zendesk refused the authorization. */
async function accessTokenOrNull(
  orgId: string,
  connection: ZendeskConnection,
  env: AppEnv["Variables"]["env"],
): Promise<string | null> {
  try {
    return await freshZendeskAccessToken({ orgId, env, connection })
  } catch (caught) {
    if (caught instanceof ZendeskAuthorizationRevokedError) return null
    throw caught
  }
}

/**
 * Org-admin routes of the Zendesk connector (ADR-054). The connection holds
 * auth only; each Workspace selects its categories and views in its sources.
 */
export const zendeskConnectorRoutes = new OpenAPIHono<AppEnv>()
  .openapi(draftRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { subdomain } = c.req.valid("json")
    return c.json(
      { connectionId: await createZendeskDraft({ orgId, subdomain }) },
      200,
    )
  })
  .openapi(oauthClientRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const body = c.req.valid("json")
    const saved = await saveZendeskOAuthClient({
      orgId,
      connectionId: body.connectionId,
      env: c.var.env,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
    })
    return saved
      ? c.body(null, 204)
      : c.json({ error: UNKNOWN_CONNECTION }, 404)
  })
  .openapi(oauthStartRoute, async (c) => {
    const user = c.get("user")
    const orgId = c.get("orgId")
    const orgSlug = c.get("orgSlug")
    if (!user || !orgId || !orgSlug)
      return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = c.req.valid("query")
    const connection = await getZendeskConnection(
      orgId,
      connectionId,
      c.var.env,
    )
    if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404)
    if (!connection.oauthClient)
      return c.json(
        { error: "Save the Zendesk OAuth client of this deployment first" },
        409,
      )
    const { state, nonce } = createZendeskOAuthState({
      authSecret: c.var.env.AUTH_SECRET,
      orgId,
      orgSlug,
      userId: user.id,
      connectionId,
    })
    const pkce = createZendeskPkcePair()
    c.header(
      "Set-Cookie",
      zendeskPkceCookieHeader({
        nonce,
        codeVerifier: pkce.codeVerifier,
        secure: cookieSecure(c.var.env),
      }),
    )
    return c.json(
      {
        authorizationUrl: zendeskAuthorizeUrl({
          subdomain: connection.subdomain,
          clientId: connection.oauthClient.clientId,
          redirectUri: zendeskRedirectUri(c.var.env),
          state,
          codeChallenge: pkce.codeChallenge,
        }),
      },
      200,
    )
  })
  .openapi(statusRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = c.req.valid("query")
    const connection = await getZendeskConnection(
      orgId,
      connectionId,
      c.var.env,
    )
    if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404)
    return c.json(
      {
        status: connection.status,
        subdomain: connection.subdomain,
        oauthClientConfigured: Boolean(connection.oauthClient),
        deploymentOAuthClient: Boolean(
          c.var.env.ZENDESK_CLIENT_ID && c.var.env.ZENDESK_CLIENT_SECRET,
        ),
        redirectUri: zendeskRedirectUri(c.var.env),
        webhookConfigured: Boolean(connection.webhookId),
      },
      200,
    )
  })
  .openapi(catalogRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = c.req.valid("query")
    const connection = await getZendeskConnection(
      orgId,
      connectionId,
      c.var.env,
    )
    if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404)
    const accessToken =
      connection.status === "installed"
        ? await accessTokenOrNull(orgId, connection, c.var.env)
        : null
    if (!accessToken) return c.json({ error: RECONNECT_MESSAGE }, 400)
    const auth = { subdomain: connection.subdomain, accessToken }
    try {
      const [categories, views] = await Promise.all([
        listZendeskCategories(auth),
        listZendeskViews(auth),
      ])
      return c.json({ categories, views }, 200)
    } catch (caught) {
      if (caught instanceof ZendeskAuthorizationRevokedError)
        return c.json({ error: RECONNECT_MESSAGE }, 400)
      throw caught
    }
  })
  .openapi(deleteRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = c.req.valid("query")
    const connection = await getZendeskConnection(
      orgId,
      connectionId,
      c.var.env,
    )
    if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404)
    // Delete the webhook, then revoke the token, while the token works. A
    // failure does not block the removal: the docs tell the admin to check
    // the Zendesk webhooks, and the log names the step that failed.
    if (connection.status === "installed") {
      const accessToken = await accessTokenOrNull(
        orgId,
        connection,
        c.var.env,
      ).catch((caught: unknown) => {
        getLogger().warn("zendesk_token_read_failed", {
          connectionId,
          error: loggableZendeskError(caught),
        })
        return null
      })
      const auth = accessToken
        ? { subdomain: connection.subdomain, accessToken }
        : null
      if (auth && connection.webhookId)
        await deleteZendeskWebhook({
          ...auth,
          webhookId: connection.webhookId,
        }).catch((caught: unknown) =>
          getLogger().warn("zendesk_webhook_delete_failed", {
            connectionId,
            error: formatUnknownError(caught),
          }),
        )
      if (auth)
        await revokeZendeskAccessToken(auth).catch((caught: unknown) =>
          getLogger().warn("zendesk_token_revoke_failed", {
            connectionId,
            error: formatUnknownError(caught),
          }),
        )
    }
    return (await deleteZendeskConnection(orgId, connectionId))
      ? c.body(null, 204)
      : c.json({ error: UNKNOWN_CONNECTION }, 404)
  })

/** The tiny same-origin page that hands the OAuth result to the setup. */
function relay(input: {
  origin: string
  orgSlug: string
  result:
    | { type: "zendesk-oauth-complete"; connectionId: string }
    | { type: "zendesk-oauth-error"; error: string }
  cookie: string
}): Response {
  const payload = JSON.stringify({
    orgSlug: input.orgSlug,
    ...input.result,
  }).replaceAll("<", "\\u003c")
  const done = input.result.type === "zendesk-oauth-complete"
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${done ? "Zendesk connected" : "Zendesk authorization failed"}</title><script>const result=${payload};try{window.opener?.postMessage(result,${JSON.stringify(input.origin)});localStorage.setItem("zendesk-setup-result",JSON.stringify(result))}finally{window.close()}</script><p>${done ? "Zendesk connected." : "Zendesk authorization failed."} You can close this window.</p>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "Set-Cookie": input.cookie,
      },
    },
  )
}

/**
 * The OAuth callback. It saves the tokens, then creates the article
 * webhook. A webhook that Zendesk refuses (the user is not a Zendesk
 * admin) leaves the connection on the daily sync.
 */
export const zendeskOauthCallbackRoutes = new OpenAPIHono<AppEnv>().openapi(
  callbackRoute,
  async (c) => {
    const user = c.get("user")
    if (!user || !c.get("session"))
      return c.json({ error: "Unauthorized" }, 401)
    // Only a browser session connects Zendesk. A personal API key gets a
    // session with the role of its user, so refuse it here, as
    // requireOrgAdminOrOwner does on the other routes.
    if (c.get("personalApiKeyId") || c.get("orgApiKey"))
      return c.json({ error: "Forbidden" }, 403)
    const query = c.req.valid("query")
    const env = c.var.env
    // Every answer clears the one-time PKCE cookie.
    const cookie = zendeskPkceCookieHeader({ secure: cookieSecure(env) })
    const state = query.state
      ? verifyZendeskOAuthState({
          authSecret: c.var.env.AUTH_SECRET,
          state: query.state,
        })
      : undefined
    if (!state || state.userId !== user.id)
      return c.json({ error: "Invalid Zendesk OAuth state" }, 400, {
        "Set-Cookie": cookie,
      })
    const fail = (message: string) =>
      relay({
        origin: new URL(env.AUTH_BASE_URL).origin,
        orgSlug: state.orgSlug,
        result: { type: "zendesk-oauth-error", error: message },
        cookie,
      })
    if (query.error) return fail(`Zendesk authorization failed: ${query.error}`)
    const codeVerifier = zendeskPkceVerifierFromCookie(
      c.req.header("cookie"),
      state.nonce,
    )
    if (!query.code || !codeVerifier)
      return c.json(
        { error: "Missing Zendesk OAuth code or PKCE verifier" },
        400,
        { "Set-Cookie": cookie },
      )
    if (
      !(await hasOrgAdminOrOwnerRole({
        headers: c.req.raw.headers,
        orgId: state.orgId,
      }))
    )
      return fail("You no longer have permission to connect Zendesk")
    const connection = await getZendeskConnection(
      state.orgId,
      state.connectionId,
      env,
    )
    if (!connection) return fail("The Zendesk setup was removed")
    if (!connection.oauthClient)
      return fail("The Zendesk OAuth client is missing")

    let tokens: Awaited<ReturnType<typeof exchangeZendeskCode>>
    try {
      tokens = await exchangeZendeskCode({
        subdomain: connection.subdomain,
        creds: connection.oauthClient,
        code: query.code,
        codeVerifier,
        redirectUri: zendeskRedirectUri(env),
      })
    } catch (exchangeError) {
      getLogger().warn("zendesk_oauth_exchange_failed", {
        connectionId: connection.id,
        error: formatUnknownError(exchangeError),
      })
      return fail(
        "Zendesk did not complete the authorization. Check the OAuth client, then try again.",
      )
    }
    await saveZendeskTokens({
      orgId: state.orgId,
      connectionId: connection.id,
      env,
      tokens,
    })
    if (!connection.webhookId) {
      const auth = {
        subdomain: connection.subdomain,
        accessToken: tokens.accessToken,
      }
      try {
        const webhook = await createZendeskArticleWebhook({
          ...auth,
          endpoint: `${env.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/webhook/zendesk/${connection.id}`,
        })
        try {
          await saveZendeskWebhook({
            orgId: state.orgId,
            connectionId: connection.id,
            env,
            ...webhook,
          })
        } catch (saveError) {
          await deleteZendeskWebhook({ ...auth, webhookId: webhook.webhookId })
          throw saveError
        }
      } catch (webhookError) {
        getLogger().warn("zendesk_webhook_create_failed", {
          connectionId: connection.id,
          error: formatUnknownError(webhookError),
        })
      }
    }
    return relay({
      origin: new URL(env.AUTH_BASE_URL).origin,
      orgSlug: state.orgSlug,
      result: { type: "zendesk-oauth-complete", connectionId: connection.id },
      cookie,
    })
  },
)
