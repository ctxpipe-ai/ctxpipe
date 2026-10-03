import { SignJWT } from "jose"
import { describe, expect, it } from "vitest"
import type { Env } from "../config/env.js"
import { createApp } from "../app/app.js"
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

async function signToken(
  workspaceId?: string,
  legacyWorkspace?: true,
): Promise<string> {
  return new SignJWT({
    orgId: "org_test",
    principal: "service",
    ...(workspaceId ? { workspaceId } : {}),
    ...(legacyWorkspace ? { legacyWorkspace } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("repo:repo_test")
    .setIssuer("ctxpipe-test")
    .setAudience("codesearch")
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(env.AUTH_SECRET))
}

describe("checkoutKeyFromAuth", () => {
  it("rejects an unbound workspace token at the native HTTP boundary", async () => {
    const response = await createApp(env).request("/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await signToken("ws_alpha")}`,
      },
      body: JSON.stringify({ Q: "anything" }),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Unauthorized" })
  })
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

  it("derives the legacy checkout only from an explicit legacy workspace token", async () => {
    const auth = await verifyCodesearchJwt({
      env,
      authorizationHeader: `Bearer ${await signToken("ws_alpha", true)}`,
    })

    expect(auth).not.toBeNull()
    expect(checkoutKeyFromAuth(auth as VerifiedToken)).toBe("ws:ws_alpha")
  })
})
