import { jwtVerify } from "jose"
import type { Env } from "../config/env.js"

export type VerifiedToken = {
  sub: string
  orgId: string
  principal: "user" | "service"
}

function readBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null
  const [scheme, token] = authHeader.split(" ")
  if (scheme !== "Bearer" || !token) return null
  return token
}

function getSecret(env: Env): Uint8Array {
  if (!env.AUTH_SECRET) {
    throw new Error("AUTH_SECRET is required for codesearch JWT verification")
  }
  return new TextEncoder().encode(env.AUTH_SECRET)
}

export async function verifyCodesearchJwt(input: {
  env: Env
  authorizationHeader: string | undefined
}): Promise<VerifiedToken | null> {
  const token = readBearerToken(input.authorizationHeader)
  if (!token) return null

  const expectedIssuer =
    input.env.AUTH_ISSUER ?? input.env.AUTH_BASE_URL ?? "ctxpipe-backend"
  const { payload } = await jwtVerify(token, getSecret(input.env), {
    issuer: expectedIssuer,
    audience: input.env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
  })

  const subject = payload.sub
  const orgId = payload.orgId
  const principal = payload.principal
  if (
    typeof subject !== "string" ||
    typeof orgId !== "string" ||
    (principal !== "user" && principal !== "service")
  ) {
    return null
  }

  return {
    sub: subject,
    orgId,
    principal,
  }
}
