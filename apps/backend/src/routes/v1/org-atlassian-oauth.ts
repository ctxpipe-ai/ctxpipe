import { createHash, randomBytes } from "node:crypto"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import { SignJWT } from "jose"
import type { AppEnv } from "../../app/env.js"
import { requireOrgAdminOrOwner } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import {
  CONNECTION_TYPE_FORGE,
  connections,
} from "../../db/schema/connections.js"
import {
  type ForgeConnectionConfig,
  tryParseForgeConnectionConfig,
} from "../../lib/connection-config.js"
import { patchForgeConnectionTypedConfig } from "../../models/atlassian-connector.js"
import {
  forgeConnectionHasAtlassianOauthCredsInConfig,
  getAtlassianOauthCredsForForgeConnection,
} from "../../models/atlassian-oauth-creds.js"

const ATLASSIAN_OAUTH_SCOPES = [
  "read:jira-user",
  "read:confluence-user",
  "offline_access",
  "read:me",
  "read:account",
] as const

const ATLASSIAN_AUTH = "https://auth.atlassian.com/authorize"

const ConnectionIdQuery = z.object({
  connectionId: z.string().min(1),
})

const PutBody = z
  .object({
    clientId: z.string().min(1),
    /** Omitted or empty to keep the existing secret when already saved. Required on first save. */
    clientSecret: z.string().optional(),
  })
  .openapi("OrgAtlassianOauthPut")

function oauthCallbackUrlValue(): string {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  return new URL(
    "/api/v1/integrations/atlassian/callback",
    env.AUTH_BASE_URL,
  ).toString()
}

function getSecretKey(): Uint8Array {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  return new TextEncoder().encode(env.AUTH_SECRET)
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function newPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(32))
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  )
  return { codeVerifier, codeChallenge }
}

function safeReturnPath(p: string | null | undefined, orgSlug: string): string {
  if (!p || typeof p !== "string") {
    return `/${orgSlug}/connectors`
  }
  if (!p.startsWith("/") || p.startsWith("//") || p.length > 2_000) {
    return `/${orgSlug}/connectors`
  }
  return p
}

/**
 * `ATLASSIAN_CLIENT_ID` + `SECRET` in env enable Better Auth’s global Atlassian
 * provider. When set, the product prefers that and does not ask for per-connection 3LO.
 */
function globalAtlassianOAuthConfiguredFromEnv(): boolean {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  return Boolean(
    env.ATLASSIAN_CLIENT_ID?.trim() && env.ATLASSIAN_CLIENT_SECRET?.trim(),
  )
}

const OrgAtlassianOauthGetResponse = z
  .object({
    oauthAppSaved: z.boolean(),
    atlassianOAuthClientId: z.string().nullable(),
    globalAtlassianOAuthConfigured: z.boolean(),
    oauthCallbackUrl: z.string(),
    atlassianCreateUrl: z.string(),
  })
  .openapi("OrgAtlassianOauthGetResponse")

const getRoute = createRoute({
  method: "get",
  path: "/",
  request: { query: ConnectionIdQuery },
  responses: {
    200: {
      content: {
        "application/json": { schema: OrgAtlassianOauthGetResponse },
      },
      description: "Forge connection Atlassian 3LO metadata (no secrets)",
    },
    401: { description: "Unauthorized" },
    404: { description: "Not found" },
  },
})

const putRoute = createRoute({
  method: "put",
  path: "/",
  request: {
    query: ConnectionIdQuery,
    body: { content: { "application/json": { schema: PutBody } } },
  },
  responses: {
    204: { description: "Saved" },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
  },
})

const AuthorizeQuery = z.object({
  connectionId: z.string().min(1),
  returnTo: z.string().optional(),
})

const authorizeGet = createRoute({
  method: "get",
  path: "/authorize",
  request: {
    query: AuthorizeQuery,
  },
  responses: {
    302: { description: "Redirect" },
    400: { description: "Bad request" },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
  },
})

/** Any org member: metadata for linking Atlassian (no secrets). */
export const orgAtlassianOauthReadRoutes = new OpenAPIHono<AppEnv>().openapi(
  getRoute,
  async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) {
      return c.json({ error: "Not found" }, 404)
    }
    const connectionId = c.req.query("connectionId")
    if (!connectionId) {
      return c.json({ error: "connectionId is required" }, 400)
    }
    const db = getSystemDb()
    const [row] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_FORGE),
        ),
      )
      .limit(1)
    if (!row) {
      return c.json({ error: "Forge connection not found" }, 404)
    }
    const rawConfig = row.config as Record<string, unknown>
    const oauthAppSaved =
      forgeConnectionHasAtlassianOauthCredsInConfig(rawConfig)
    const parsed = tryParseForgeConnectionConfig(rawConfig)
    const atlassianOAuthClientId =
      parsed?.atlassianOAuthClientId?.trim() || null
    return c.json(
      {
        oauthAppSaved,
        atlassianOAuthClientId,
        globalAtlassianOAuthConfigured: globalAtlassianOAuthConfiguredFromEnv(),
        oauthCallbackUrl: oauthCallbackUrlValue(),
        atlassianCreateUrl:
          "https://developer.atlassian.com/cloud/oauth-2-3lo-apps",
      },
      200,
    )
  },
)

const orgAtlassianOauthAdminHandlers = new OpenAPIHono<AppEnv>()
  .openapi(putRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Forbidden" }, 403)
    const connectionId = c.req.query("connectionId")
    if (!connectionId) {
      return c.json({ error: "connectionId is required" }, 400)
    }
    const body = PutBody.parse(await c.req.json())
    const [row] = await getSystemDb()
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_FORGE),
        ),
      )
      .limit(1)
    if (!row) {
      return c.json({ error: "Forge connection not found" }, 404)
    }
    const hasSavedOauth = forgeConnectionHasAtlassianOauthCredsInConfig(
      row.config as Record<string, unknown>,
    )
    const newSecret = body.clientSecret?.trim() ?? ""
    if (!hasSavedOauth && !newSecret) {
      return c.json(
        { error: "clientSecret is required when saving for the first time" },
        400,
      )
    }
    const patch: Partial<ForgeConnectionConfig> = {
      atlassianOAuthClientId: body.clientId,
    }
    if (newSecret) {
      patch.atlassianOAuthClientSecret = newSecret
    }
    const out = await patchForgeConnectionTypedConfig(
      orgId,
      connectionId,
      patch,
    )
    if (!out) {
      return c.json({ error: "Forge connection not found" }, 404)
    }
    return c.body(null, 204)
  })
  .openapi(authorizeGet, async (c) => {
    const orgId = c.get("orgId")
    const orgSlug = c.get("orgSlug")
    const user = c.get("user") as { id: string } | null
    if (!orgId || !orgSlug || !user) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    const connectionId = c.req.query("connectionId")
    if (!connectionId) {
      return c.json({ error: "connectionId is required" }, 400)
    }

    const creds = await getAtlassianOauthCredsForForgeConnection(
      orgId,
      connectionId,
    )
    if (!creds) {
      return c.json(
        {
          error:
            "This Forge connection has no Atlassian OAuth app saved in its config",
          code: "forge_atlassian_oauth_missing",
        },
        400,
      )
    }

    const { codeVerifier, codeChallenge } = newPkcePair()
    const returnTo = safeReturnPath(c.req.query("returnTo"), orgSlug)
    const state = await new SignJWT({
      org: orgId,
      connectionId,
      returnTo,
      cv: codeVerifier,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(getSecretKey())

    const u = new URL(ATLASSIAN_AUTH)
    u.searchParams.set("audience", "api.atlassian.com")
    u.searchParams.set("client_id", creds.clientId)
    u.searchParams.set("scope", [...ATLASSIAN_OAUTH_SCOPES].join(" "))
    u.searchParams.set("redirect_uri", oauthCallbackUrlValue())
    u.searchParams.set("response_type", "code")
    u.searchParams.set("state", state)
    u.searchParams.set("code_challenge", codeChallenge)
    u.searchParams.set("code_challenge_method", "S256")
    u.searchParams.set("prompt", "consent")
    return c.redirect(u.toString(), 302)
  })

export const orgAtlassianOauthAdminRoutes = new OpenAPIHono<AppEnv>()
  .use("*", requireOrgAdminOrOwner)
  .route("/", orgAtlassianOauthAdminHandlers)
