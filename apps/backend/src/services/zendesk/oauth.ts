import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import { z } from "zod"
import type { Env } from "../../config/env.js"
import { assertNotInOrgDbContext } from "../../db/client.js"

/**
 * The scopes that ctx| asks for (ADR-054): read Help Center, tickets,
 * views, and users, and manage the one webhook that ctx| creates.
 */
export const ZENDESK_OAUTH_SCOPES = [
  "hc:read",
  "tickets:read",
  "ticket_views:read",
  "users:read",
  "webhooks:read",
  "webhooks:write",
] as const

export { isZendeskSubdomain } from "../../lib/connection-config.js"

export function zendeskRedirectUri(env: Env): string {
  return `${env.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/integrations/zendesk/callback`
}

export type ZendeskOAuthClient = { clientId: string; clientSecret: string }

export class ZendeskAuthorizationRevokedError extends Error {
  constructor(message = "Zendesk does not accept the authorization") {
    super(message)
    this.name = "ZendeskAuthorizationRevokedError"
  }
}

const stateSchema = z.object({
  exp: z.number().int().positive(),
  nonce: z.string().min(1),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  userId: z.string().min(1),
  connectionId: z.string().min(1),
})
export type ZendeskOAuthState = z.infer<typeof stateSchema>

const sign = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url")

/** A signed state that expires in 10 minutes. It holds no secret. */
export function createZendeskOAuthState(input: {
  authSecret: string
  orgId: string
  orgSlug: string
  userId: string
  connectionId: string
  now?: number
}): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      exp: (input.now ?? Date.now()) + 10 * 60 * 1000,
      nonce,
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      userId: input.userId,
      connectionId: input.connectionId,
    } satisfies ZendeskOAuthState),
  ).toString("base64url")
  return { state: `${payload}.${sign(payload, input.authSecret)}`, nonce }
}

export function verifyZendeskOAuthState(input: {
  authSecret: string
  state: string
  now?: number
}): ZendeskOAuthState | undefined {
  const [payload, signature, extra] = input.state.split(".")
  if (!payload || !signature || extra) return undefined
  const expected = Buffer.from(sign(payload, input.authSecret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return undefined
  try {
    const parsed = stateSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    )
    return parsed.exp > (input.now ?? Date.now()) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function createZendeskPkcePair(): {
  codeVerifier: string
  codeChallenge: string
} {
  const codeVerifier = randomBytes(32).toString("base64url")
  return {
    codeVerifier,
    codeChallenge: createHash("sha256")
      .update(codeVerifier)
      .digest("base64url"),
  }
}

const PKCE_COOKIE = "zendesk_pkce"

/** The PKCE verifier stays in an HttpOnly cookie, bound to the state nonce. */
export function zendeskPkceCookieHeader(input: {
  nonce?: string
  codeVerifier?: string
  secure: boolean
}): string {
  const value =
    input.nonce && input.codeVerifier
      ? `${input.nonce}.${input.codeVerifier}`
      : ""
  return [
    `${PKCE_COOKIE}=${value}`,
    "Path=/api/v1/integrations/zendesk",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${value ? 600 : 0}`,
    ...(input.secure ? ["Secure"] : []),
  ].join("; ")
}

export function zendeskPkceVerifierFromCookie(
  cookieHeader: string | undefined,
  nonce: string,
): string | undefined {
  for (const part of cookieHeader?.split(";") ?? []) {
    const [name, value = ""] = part.trim().split("=", 2)
    if (name !== PKCE_COOKIE) continue
    const separator = value.indexOf(".")
    return separator > 0 && value.slice(0, separator) === nonce
      ? value.slice(separator + 1) || undefined
      : undefined
  }
  return undefined
}

export function zendeskAuthorizeUrl(input: {
  subdomain: string
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const url = new URL(
    `https://${input.subdomain}.zendesk.com/oauth/authorizations/new`,
  )
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("scope", ZENDESK_OAUTH_SCOPES.join(" "))
  url.searchParams.set("state", input.state)
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.toString()
}

export type ZendeskTokens = {
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: string | null
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullish(),
  expires_in: z.number().int().positive().nullish(),
})

async function requestTokens(input: {
  subdomain: string
  body: Record<string, string>
  now?: number
}): Promise<ZendeskTokens> {
  assertNotInOrgDbContext()
  const response = await fetch(
    `https://${input.subdomain}.zendesk.com/oauth/tokens`,
    {
      signal: AbortSignal.timeout(30_000),
      // A redirect must not take the client secret or the code to another host.
      redirect: "error",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.body),
    },
  )
  if (response.status === 400 || response.status === 401)
    throw new ZendeskAuthorizationRevokedError(
      `Zendesk token request failed (${response.status})`,
    )
  if (!response.ok)
    throw new Error(`Zendesk token request failed (${response.status})`)
  const tokens = tokenResponseSchema.parse(await response.json())
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    accessTokenExpiresAt: tokens.expires_in
      ? new Date(
          (input.now ?? Date.now()) + tokens.expires_in * 1000,
        ).toISOString()
      : null,
  }
}

export function exchangeZendeskCode(input: {
  subdomain: string
  creds: ZendeskOAuthClient
  code: string
  codeVerifier: string
  redirectUri: string
  now?: number
}): Promise<ZendeskTokens> {
  return requestTokens({
    subdomain: input.subdomain,
    now: input.now,
    body: {
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.creds.clientId,
      client_secret: input.creds.clientSecret,
      redirect_uri: input.redirectUri,
      scope: ZENDESK_OAUTH_SCOPES.join(" "),
      code_verifier: input.codeVerifier,
    },
  })
}

/** Each refresh gives a new pair; the old refresh token stops working. */
export function refreshZendeskToken(input: {
  subdomain: string
  creds: ZendeskOAuthClient
  refreshToken: string
  now?: number
}): Promise<ZendeskTokens> {
  return requestTokens({
    subdomain: input.subdomain,
    now: input.now,
    body: {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.creds.clientId,
      client_secret: input.creds.clientSecret,
    },
  })
}
