import { SignJWT } from "jose"
import { describe, expect, it } from "vitest"

import { createApp } from "../app/app.js"
import type { Env } from "../config/env.js"
import {
  checkoutKeyFromAuth,
  indexCheckoutFromAuth,
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
  claims: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({
    orgId: "org_test",
    principal: "service",
    ...(workspaceId ? { workspaceId } : {}),
    ...claims,
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
  it("rejects a Workspace token with the old claim at the native HTTP boundary", async () => {
    const response = await createApp(env).request("/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await signToken("ws_alpha", {
          workspaceRevisions: [
            { repositoryId: "repo_linked", sha: "c".repeat(40) },
          ],
        })}`,
      },
      body: JSON.stringify({ Q: "anything" }),
    })
    expect(response.status).toBe(401)
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

  it("rejects a legacy workspace token that lists no repository", async () => {
    await expect(
      verifyCodesearchJwt({
        env,
        authorizationHeader: `Bearer ${await signToken("ws_alpha", { legacyWorkspace: true })}`,
      }),
    ).resolves.toBeNull()
  })

  it("maps a Workspace token to the published checkout of each linked repository in its own org only", async () => {
    const auth = (await verifyCodesearchJwt({
      env,
      authorizationHeader: `Bearer ${await signToken("ws_alpha", { workspaceRepositoryIds: ["repo_linked"] })}`,
    })) as VerifiedToken
    expect(auth.orgId).toBe("org_test")
    expect(auth.workspaceRepositoryIds).toEqual(["repo_linked"])
    const published = `rev:${"b".repeat(40)}`

    expect(checkoutKeyFromAuth(auth, "repo_linked", published)).toBe(published)
    expect(() => checkoutKeyFromAuth(auth, "repo_other", published)).toThrow(
      expect.objectContaining({ status: 403 }),
    )
    // A write path gives no published key: a Workspace token cannot write.
    expect(() => checkoutKeyFromAuth(auth, "repo_linked")).toThrow(
      expect.objectContaining({ status: 403 }),
    )
    expect(() =>
      indexCheckoutFromAuth(auth, "repo_linked", "c".repeat(40)),
    ).toThrow(expect.objectContaining({ status: 403 }))
  })

  it.each([
    [
      "the old Workspace claim",
      "ws_alpha",
      {
        workspaceRevisions: [
          { repositoryId: "repo_linked", sha: "c".repeat(40) },
        ],
      },
    ],
    [
      "both Workspace claim shapes",
      "ws_alpha",
      {
        workspaceRepositoryIds: ["repo_linked"],
        workspaceRevisions: [
          { repositoryId: "repo_linked", sha: "c".repeat(40) },
        ],
      },
    ],
    [
      "repository ids without a Workspace",
      undefined,
      { workspaceRepositoryIds: ["repo_linked"] },
    ],
    ["an empty repository list", "ws_alpha", { workspaceRepositoryIds: [] }],
    [
      "a run revision and a Workspace",
      "ws_alpha",
      {
        workspaceRepositoryIds: ["repo_linked"],
        repositoryRevisions: [
          { repositoryId: "repo_linked", sha: "c".repeat(40) },
        ],
      },
    ],
  ])("rejects a token with %s", async (_case, workspaceId, claims) => {
    await expect(
      verifyCodesearchJwt({
        env,
        authorizationHeader: `Bearer ${await signToken(workspaceId, claims)}`,
      }),
    ).resolves.toBeNull()
  })

  it("keeps an ingestion run token on its own revision", async () => {
    const sha = "d".repeat(40)
    const auth = (await verifyCodesearchJwt({
      env,
      authorizationHeader: `Bearer ${await signToken(undefined, {
        repositoryRevisions: [{ repositoryId: "repo_run", sha }],
      })}`,
    })) as VerifiedToken
    expect(checkoutKeyFromAuth(auth, "repo_run", "rev:other")).toBe(
      `rev:${sha}`,
    )
    expect(indexCheckoutFromAuth(auth, "repo_run", sha)).toBe(`rev:${sha}`)
  })
})
