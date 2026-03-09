import { SignJWT } from "jose"
import type { Env } from "../config/env.js"

type UpstreamPrincipal = "user" | "service"

export type UpstreamClaims = {
  sub: string
  orgId: string
  principal: UpstreamPrincipal
}

function getSigningSecret(env: Env): Uint8Array {
  if (!env.AUTH_SECRET) {
    throw new Error("AUTH_SECRET is required for upstream JWT signing")
  }
  return new TextEncoder().encode(env.AUTH_SECRET)
}

export async function signUpstreamJwt(input: {
  env: Env
  audience: string
  claims: UpstreamClaims
}): Promise<string> {
  const issuer =
    input.env.AUTH_ISSUER ?? input.env.AUTH_BASE_URL ?? "ctxpipe-backend"
  return new SignJWT({
    orgId: input.claims.orgId,
    principal: input.claims.principal,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.claims.sub)
    .setIssuer(issuer)
    .setAudience(input.audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(getSigningSecret(input.env))
}
