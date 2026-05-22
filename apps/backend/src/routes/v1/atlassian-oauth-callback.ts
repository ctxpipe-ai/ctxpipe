import { and, eq } from "drizzle-orm"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { jwtVerify } from "jose"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { accounts, members, organizations } from "../../db/schema/auth.js"
import { generateObjectId } from "../../lib/id.js"
import { getLogger } from "../../observability/logger.js"
import { getAtlassianOauthCredsForForgeConnection } from "../../models/atlassian-oauth-creds.js"

const ATLASSIAN_TOKEN = "https://auth.atlassian.com/oauth/token"
const ATLASSIAN_ME = "https://api.atlassian.com/me"

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

function safeReturnPath(
  p: string | null | undefined,
  orgSlug: string,
): string {
  if (!p || typeof p !== "string") {
    return `/${orgSlug}/connectors`
  }
  if (!p.startsWith("/") || p.startsWith("//") || p.length > 2_000) {
    return `/${orgSlug}/connectors`
  }
  return p
}

const callbackGet = createRoute({
  method: "get",
  path: "/callback",
  request: {
    query: z.object({
      state: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }),
  },
  responses: {
    302: { description: "Redirect" },
    400: { description: "Bad request" },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
  },
})

export const atlassianOauthCallbackRoutes = new OpenAPIHono<AppEnv>().openapi(
  callbackGet,
  async (c) => {
    const err = c.req.query("error")
    const errDesc = c.req.query("error_description")
    if (err) {
      getLogger().warn("Atlassian OAuth error", { err, errDesc })
      const env = parseEnv(process.env as Record<string, string | undefined>)
      return c.redirect(
        new URL(
          `/?atlassian_error=${encodeURIComponent(err)}`,
          env.AUTH_BASE_URL,
        ).toString(),
        302,
      )
    }
    const code = c.req.query("code")
    const state = c.req.query("state")
    if (!code || !state) {
      return c.json({ error: "Missing code or state" }, 400)
    }

    const user = c.get("user") as { id: string } | null
    if (!user) return c.json({ error: "Unauthorized" }, 401)

    let payload: {
      org: string
      connectionId: string
      returnTo: string
      cv: string
      sub?: string
    }
    try {
      const { payload: p } = await jwtVerify(state, getSecretKey(), {
        algorithms: ["HS256"],
      })
      if (!p.sub) throw new Error("missing sub")
      if (!p.connectionId) throw new Error("missing connectionId")
      payload = {
        org: String(p.org),
        connectionId: String(p.connectionId),
        returnTo: String(p.returnTo),
        cv: String(p.cv),
        sub: p.sub,
      }
    } catch (e) {
      getLogger().error(e instanceof Error ? e : new Error(String(e)), {
        step: "atlassian-callback-bad-state",
      })
      return c.json({ error: "Invalid or expired state" }, 400)
    }
    if (payload.sub !== user.id) {
      return c.json({ error: "Session mismatch" }, 403)
    }

    const db = getSystemDb()
    const [member] = await db
      .select()
      .from(members)
      .where(
        and(
          eq(members.organizationId, payload.org),
          eq(members.userId, user.id),
        ),
      )
      .limit(1)
    if (!member) {
      return c.json({ error: "Not a member of this organization" }, 403)
    }

    const creds = await getAtlassianOauthCredsForForgeConnection(
      payload.org,
      payload.connectionId,
    )
    if (!creds) {
      return c.json(
        { error: "Atlassian OAuth app not configured for this connection" },
        400,
      )
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: oauthCallbackUrlValue(),
      code_verifier: payload.cv,
    })

    const tokenRes = await fetch(ATLASSIAN_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
    if (!tokenRes.ok) {
      const t = await tokenRes.text()
      getLogger().error("Atlassian token exchange failed", {
        status: tokenRes.status,
        t,
      })
      return c.json(
        { error: "Token exchange failed", code: "forge_auth_failed" },
        400,
      )
    }
    const tok = (await tokenRes.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      scope?: string
    }

    const meRes = await fetch(ATLASSIAN_ME, {
      headers: { authorization: `Bearer ${tok.access_token}` },
    })
    if (!meRes.ok) {
      return c.json({ error: "Failed to load Atlassian profile" }, 400)
    }
    const me = (await meRes.json()) as {
      account_id: string
      name: string
      email?: string
      picture?: string
    }
    const accessExp = tok.expires_in
      ? new Date(Date.now() + tok.expires_in * 1000)
      : null

    const [existing] = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, user.id),
          eq(accounts.providerId, "atlassian"),
        ),
      )
      .limit(1)

    if (existing) {
      await db
        .update(accounts)
        .set({
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token ?? null,
          accessTokenExpiresAt: accessExp,
          scope: tok.scope ?? null,
          accountId: me.account_id,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, existing.id))
    } else {
      await db.insert(accounts).values({
        id: generateObjectId("acct"),
        userId: user.id,
        accountId: me.account_id,
        providerId: "atlassian",
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? null,
        accessTokenExpiresAt: accessExp,
        scope: tok.scope ?? null,
        idToken: null,
        password: null,
        refreshTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }

    const env = parseEnv(process.env as Record<string, string | undefined>)
    const [orgRow] = await db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, payload.org))
      .limit(1)
    const slug = orgRow?.slug ?? "org"
    const pathTo = safeReturnPath(payload.returnTo, slug)
    return c.redirect(new URL(pathTo, env.AUTH_BASE_URL).toString(), 302)
  },
)
