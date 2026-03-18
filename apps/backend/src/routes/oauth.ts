import { Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import { getSystemDb } from "../db/client.js"
import { connectors } from "../db/schema/connectors.js"
import { consumeOAuthState } from "../models/oauth-states.js"
import { encrypt } from "../services/crypto.js"
import { and, eq } from "drizzle-orm"

export const oauthRoutes = new Hono<AppEnv>()

/**
 * GET /oauth/atlassian/callback
 *
 * Public route — called by Atlassian after the user grants consent.
 * Exchanges the code for tokens, resolves the cloudId (Cloud only),
 * encrypts the refresh token, and stores everything on the connector.
 */
oauthRoutes.get("/atlassian/callback", async (c) => {
  const env = c.get("env")
  const code = c.req.query("code")
  const stateNonce = c.req.query("state")
  const errorParam = c.req.query("error")

  // Redirect back to the browser-facing app, not the ngrok tunnel URL.
  // AUTH_BASE_URL is where the user's session cookie lives.
  const uiBase = env.AUTH_BASE_URL.replace(/\/$/, "")

  if (errorParam) {
    return c.redirect(`${uiBase}/oauth/error?reason=${encodeURIComponent(errorParam)}`)
  }

  if (!code || !stateNonce) {
    return c.redirect(`${uiBase}/oauth/error?reason=missing_params`)
  }

  // Validate and consume state nonce
  const state = await consumeOAuthState(stateNonce)
  if (!state) {
    return c.redirect(`${uiBase}/oauth/error?reason=invalid_state`)
  }

  const { connectorId, orgId, orgSlug } = state
  const callbackUrl = `${env.PUBLIC_URL}/oauth/atlassian/callback`
  const db = getSystemDb()

  // Look up the connector (raw query — no org context middleware here)
  const [connector] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), eq(connectors.orgId, orgId)))
    .limit(1)

  if (!connector) {
    return c.redirect(`${uiBase}/oauth/error?reason=connector_not_found`)
  }

  const isCloud = connector.config.deploymentType !== "datacenter"

  // Determine token endpoint + client credentials
  const tokenUrl = isCloud
    ? "https://auth.atlassian.com/oauth/token"
    : `${connector.config.confluenceBaseUrl?.replace(/\/$/, "")}/rest/oauth2/latest/token`

  const clientId = isCloud
    ? (env.ATLASSIAN_CLIENT_ID ?? "")
    : (connector.config.oauthClientId ?? "")

  const clientSecret = isCloud
    ? (env.ATLASSIAN_CLIENT_SECRET ?? "")
    : (connector.config.oauthClientSecret ?? "")

  // Exchange authorisation code for tokens
  let tokenData: { access_token: string; refresh_token?: string; scope?: string }
  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error("[oauth] token exchange failed", res.status, err)
      return c.redirect(`${uiBase}/oauth/error?reason=token_exchange_failed`)
    }
    tokenData = await res.json() as typeof tokenData
  } catch (e) {
    console.error("[oauth] token exchange error", e)
    return c.redirect(`${uiBase}/oauth/error?reason=token_exchange_error`)
  }

  if (!tokenData.refresh_token) {
    console.error("[oauth] no refresh_token in response — was offline_access scope requested?")
    return c.redirect(`${uiBase}/oauth/error?reason=no_refresh_token`)
  }

  // Resolve cloudId for Cloud connectors
  let cloudId: string | undefined
  if (isCloud) {
    try {
      const res = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      })
      if (!res.ok) throw new Error(`accessible-resources: ${res.status}`)
      const sites = await res.json() as Array<{ id: string; url: string; name: string }>

      if (sites.length === 0) {
        return c.redirect(`${uiBase}/oauth/error?reason=no_accessible_sites`)
      }

      // Match against the connector's stored base URL if set, otherwise take first
      const stored = connector.config.confluenceBaseUrl?.replace(/\/$/, "").toLowerCase()
      const match = stored
        ? sites.find((s) => s.url.replace(/\/$/, "").toLowerCase() === stored)
        : null

      cloudId = (match ?? sites[0])!.id
      console.log(`[oauth] resolved cloudId=${cloudId} for connector ${connectorId}`)
    } catch (e) {
      console.error("[oauth] accessible-resources error", e)
      return c.redirect(`${uiBase}/oauth/error?reason=cloudid_resolution_failed`)
    }
  }

  // Encrypt refresh token and persist to connector
  const encryptedRefreshToken = encrypt(tokenData.refresh_token)
  const updatedConfig = {
    ...connector.config,
    oauthRefreshToken: encryptedRefreshToken,
    ...(cloudId ? { cloudId } : {}),
  }

  await db
    .update(connectors)
    .set({ config: updatedConfig, updatedAt: new Date() })
    .where(and(eq(connectors.id, connectorId), eq(connectors.orgId, orgId)))

  console.log(`[oauth] connector ${connectorId} authorised successfully`)
  return c.redirect(`${uiBase}/${orgSlug}/connectors?oauth=success`)
})
