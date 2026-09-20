import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"

const PagerdutyOAuthStateSchema = z.object({
  exp: z.number().int().positive(),
  nonce: z.string().min(1),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  userId: z.string().min(1),
  connectionId: z.string().min(1).optional(),
})

export type PagerdutyOAuthState = z.infer<typeof PagerdutyOAuthStateSchema>

export const PAGERDUTY_PKCE_COOKIE = "pagerduty_pkce"

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url")
}

export function createPagerdutyOAuthState(input: {
  authSecret: string
  orgId: string
  orgSlug: string
  userId: string
  connectionId?: string
  now?: number
}): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url")
  const payload: PagerdutyOAuthState = {
    exp: (input.now ?? Date.now()) + 10 * 60 * 1000,
    nonce,
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    userId: input.userId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  )
  return {
    state: `${encodedPayload}.${sign(encodedPayload, input.authSecret)}`,
    nonce,
  }
}

export function verifyPagerdutyOAuthState(input: {
  authSecret: string
  state: string
  now?: number
}): PagerdutyOAuthState | undefined {
  const [encodedPayload, signature, extra] = input.state.split(".")
  if (!encodedPayload || !signature || extra) return undefined
  const expected = Buffer.from(sign(encodedPayload, input.authSecret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return undefined
  }
  try {
    const parsed = PagerdutyOAuthStateSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    )
    return parsed.exp > (input.now ?? Date.now()) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function serializePagerdutyPkceCookie(input: {
  nonce: string
  codeVerifier: string
}): string {
  return `${input.nonce}.${input.codeVerifier}`
}

export function parsePagerdutyPkceCookie(
  value: string | undefined,
  nonce: string,
): string | undefined {
  if (!value) return undefined
  const separator = value.indexOf(".")
  if (separator <= 0) return undefined
  const cookieNonce = value.slice(0, separator)
  const codeVerifier = value.slice(separator + 1)
  if (!codeVerifier || cookieNonce !== nonce) return undefined
  return codeVerifier
}

export function pagerdutyPkceCookieHeader(
  value: string,
  secure: boolean,
): string {
  const parts = [
    `${PAGERDUTY_PKCE_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=600",
  ]
  if (secure) parts.push("Secure")
  return parts.join("; ")
}

export function expirePagerdutyPkceCookieHeader(secure: boolean): string {
  const parts = [
    `${PAGERDUTY_PKCE_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ]
  if (secure) parts.push("Secure")
  return parts.join("; ")
}

export function pagerdutyPkceCookieFromHeader(
  cookieHeader: string | undefined,
  nonce: string,
): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim()
    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue
    if (trimmed.slice(0, separator) !== PAGERDUTY_PKCE_COOKIE) continue
    return parsePagerdutyPkceCookie(trimmed.slice(separator + 1), nonce)
  }
  return undefined
}
