import { SignJWT } from "jose"
import { describe, expect, it } from "vitest"
import type { Env } from "../config/env.js"
import {
  checkoutKeyFromAuth,
  type VerifiedToken,
  verifyCodesearchJwt,
} from "./jwt.js"

const env: Env = {
  NODE_ENV: "test",
  PORT: 3001,
  AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  AUTH_ISSUER: "ctxpipe-test",
  AUTH_TOKEN_AUDIENCE_CODESEARCH: "codesearch",
}

async function signToken(workspaceId?: string): Promise<string> {
  return new SignJWT({
    orgId: "org_test",
    principal: "service",
    ...(workspaceId ? { workspaceId } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("repo:repo_test")
    .setIssuer("ctxpipe-test")
    .setAudience("codesearch")
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(env.AUTH_SECRET))
}

describe("checkoutKeyFromAuth", () => {
  it("uses the default checkout for a verified legacy JWT without workspaceId", async () => {
    const auth = await verifyCodesearchJwt({
      env,
      authorizationHeader: `Bearer ${await signToken()}`,
    })

    expect(auth).not.toBeNull()
    expect(checkoutKeyFromAuth(auth as VerifiedToken)).toBe("default")
  })

  it("returns null when the JWT omits orgId", async () => {
    const token = await new SignJWT({
      principal: "service",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("repo:repo_test")
      .setIssuer("ctxpipe-test")
      .setAudience("codesearch")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(env.AUTH_SECRET))

    await expect(
      verifyCodesearchJwt({
        env,
        authorizationHeader: `Bearer ${token}`,
      }),
    ).resolves.toBeNull()
  })

  it("derives the workspace checkout from a verified JWT workspaceId", async () => {
    const auth = await verifyCodesearchJwt({
      env,
      authorizationHeader: `Bearer ${await signToken("ws_alpha")}`,
    })

    expect(auth).not.toBeNull()
    expect(checkoutKeyFromAuth(auth as VerifiedToken)).toBe("ws:ws_alpha")
  })
})
