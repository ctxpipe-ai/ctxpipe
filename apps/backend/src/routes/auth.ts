import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider"
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client"
import { context } from "@opentelemetry/api"
import { createAuthClient } from "better-auth/client"
import { and, eq, gt } from "drizzle-orm"
import type { Context, Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import { atlassianLinkCallbackFirst } from "../auth/atlassian-link-callback.js"
import { getAuth } from "../auth/config.js"
import {
  logOAuthError,
  prepareBetterAuthRequest,
} from "../auth/oauth-gateway-request.js"
import { withOAuthConsentOrganizationId } from "../auth/oauth-organization.js"
import { getSystemDb } from "../db/client.js"
import { invitations, organizations } from "../db/schema/auth.js"
import { applyAttribution } from "../observability/attribution.js"
import { tryGetLogger } from "../observability/requestLogger.js"

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
  )
}

function authorizationServersForProtectedResourceMetadata(
  env: AppEnv["Variables"]["env"],
  authServerMeta: Record<string, unknown>,
): string[] {
  if (env.AUTH_ISSUER) return [env.AUTH_ISSUER]
  const issuer = authServerMeta.issuer
  if (typeof issuer === "string" && issuer.length > 0) return [issuer]
  return [new URL("/.auth/api/v1/auth", env.AUTH_BASE_URL).href]
}

async function getMcpProtectedResourceMetadata(
  c: Context<AppEnv>,
  auth: ReturnType<typeof getAuth>,
  serverClient: ReturnType<typeof createAuthClient>,
): Promise<Record<string, unknown>> {
  const authServerRes = await oauthProviderAuthServerMetadata(auth)(c.req.raw)
  let authServerMeta: Record<string, unknown> = {}
  if (authServerRes.ok) {
    try {
      authServerMeta = (await authServerRes.json()) as Record<string, unknown>
    } catch {
      authServerMeta = {}
    }
  }

  const authorization_servers =
    authorizationServersForProtectedResourceMetadata(c.var.env, authServerMeta)

  const metadata = await serverClient.getProtectedResourceMetadata({
    resource: `${c.var.env.AUTH_BASE_URL}/mcp`,
    authorization_servers,
  })
  const merged: Record<string, unknown> = {
    ...(metadata as Record<string, unknown>),
  }
  if (
    !isNonEmptyStringArray(merged.scopes_supported) &&
    isNonEmptyStringArray(authServerMeta.scopes_supported)
  ) {
    merged.scopes_supported = authServerMeta.scopes_supported
  }
  return merged
}

function isGetSessionPath(path: string): boolean {
  const pathname = (path.split("?")[0] ?? path).replace(/\/+$/, "")
  return pathname.endsWith("/get-session")
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = (value as Record<string, unknown>)[key]
  if (typeof field !== "string") return undefined
  const trimmed = field.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Copy the user and active org off a get-session JSON body.
 * The handler already loaded the session; this does not read the database.
 */
async function attributeAuthGetSessionResponse(
  path: string,
  response: Response,
): Promise<void> {
  if (!isGetSessionPath(path)) return
  if (response.status < 200 || response.status >= 300) return
  const contentType = response.headers.get("content-type") ?? ""
  if (contentType && !contentType.includes("application/json")) return
  const active = context.active()
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return
  }
  if (!body || typeof body !== "object") return
  const record = body as Record<string, unknown>
  const userId = readStringField(record.user, "id")
  if (!userId) return
  const orgId = readStringField(record.session, "activeOrganizationId")
  context.with(active, () => {
    applyAttribution(
      {
        "ctxpipe.actor.type": "user",
        "enduser.id": userId,
        ...(orgId ? { "ctxpipe.org.id": orgId } : {}),
      },
      tryGetLogger(),
    )
  })
}

export function registerAuthRoutes(app: Hono<AppEnv>) {
  const auth = getAuth()
  const serverClient = createAuthClient({
    plugins: [oauthProviderResourceClient()],
  })

  // Expose enabled social providers so the UI can render the correct sign in buttons
  // without hardcoding provider lists.
  app.get("/.auth/api/config", (c) => {
    const socialProviders = Object.entries(auth.options.socialProviders ?? {})
      .filter(([, value]) => value)
      .map(([provider]) => provider)

    return c.json({ providers: socialProviders })
  })

  app.get("/.auth/api/v1/public/invitations/:invitationId", async (c) => {
    const invitationId = c.req.param("invitationId")
    const db = getSystemDb()
    const [invitation] = await db
      .select({
        email: invitations.email,
        organizationName: organizations.name,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .innerJoin(
        organizations,
        eq(organizations.id, invitations.organizationId),
      )
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.status, "pending"),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1)

    if (!invitation) {
      return c.json({ error: "Invitation not found or expired" }, 404)
    }
    return c.json(
      {
        email: invitation.email,
        organizationName: invitation.organizationName,
      },
      200,
    )
  })

  app.on(["GET", "POST"], "/.auth/api/v1/auth/callback/atlassian", (c) =>
    atlassianLinkCallbackFirst(c),
  )

  app.on(["GET", "POST"], "/.auth/api/v1/auth/*", async (c) => {
    const prepared = await prepareBetterAuthRequest(c.req.raw, c.var.env)
    const isOAuthConsent = c.req.path.endsWith("/oauth2/consent")
    const submittedOrganizationId =
      c.req.header("x-ctxpipe-oauth-organization")?.trim() || null
    const handled = isOAuthConsent
      ? await withOAuthConsentOrganizationId(submittedOrganizationId, () =>
          auth.handler(prepared.request),
        )
      : await auth.handler(prepared.request)
    await attributeAuthGetSessionResponse(c.req.path, handled)
    if (handled.status >= 400) {
      await logOAuthError(prepared.request, handled, prepared.oauthTokenHints)
    }
    return handled
  })

  app.get("/.well-known/oauth-authorization-server", (c) =>
    oauthProviderAuthServerMetadata(auth)(c.req.raw),
  )

  app.get("/.well-known/openid-configuration", (c) =>
    oauthProviderOpenIdConfigMetadata(auth)(c.req.raw),
  )

  // RFC 8414 path-inserted discovery when clients treat the issuer as …/mcp
  app.get("/.well-known/oauth-authorization-server/mcp", (c) =>
    oauthProviderAuthServerMetadata(auth)(c.req.raw),
  )

  app.get("/.well-known/openid-configuration/mcp", (c) =>
    oauthProviderOpenIdConfigMetadata(auth)(c.req.raw),
  )

  // RFC 8414 path-inserted discovery for issuer https://<host>/.auth/api/v1/auth
  app.get("/.well-known/oauth-authorization-server/.auth/api/v1/auth", (c) =>
    oauthProviderAuthServerMetadata(auth)(c.req.raw),
  )

  app.get("/.well-known/openid-configuration/.auth/api/v1/auth", (c) =>
    oauthProviderOpenIdConfigMetadata(auth)(c.req.raw),
  )

  app.get("/mcp/.well-known/openid-configuration", (c) =>
    oauthProviderOpenIdConfigMetadata(auth)(c.req.raw),
  )

  const serveMcpProtectedResourceMetadata = async (c: Context<AppEnv>) => {
    const metadata = await getMcpProtectedResourceMetadata(
      c,
      auth,
      serverClient,
    )
    return c.json(metadata, 200, {
      "Cache-Control":
        "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
    })
  }

  // RFC 9728 default path; some MCP clients probe here before path-specific metadata.
  app.get(
    "/.well-known/oauth-protected-resource",
    serveMcpProtectedResourceMetadata,
  )

  app.get(
    "/.well-known/oauth-protected-resource/mcp",
    serveMcpProtectedResourceMetadata,
  )
  return app
}
