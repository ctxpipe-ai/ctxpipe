import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import type { VerifiedToken } from "../auth/jwt.js"
import { zoektRepositoryName } from "../domain/zoekt/shardPrefix.js"

const { pinReposMock, waitUntilMock } = vi.hoisted(() => ({
  pinReposMock: vi.fn(),
  waitUntilMock: vi.fn(),
}))

vi.mock("../domain/zoekt/pinManager.js", () => ({
  pinRepos: pinReposMock,
}))

vi.mock("../domain/zoekt/warmup.js", async () => {
  const actual = await vi.importActual<
    typeof import("../domain/zoekt/warmup.js")
  >("../domain/zoekt/warmup.js")
  return {
    ...actual,
    waitUntilZoektReposLoaded: waitUntilMock,
  }
})

vi.mock("../config/paths.js", () => ({
  ZOEKT_WEBSERVER_URL: "http://zoekt.test",
  ZOEKT_INDEX_DIR: "/cold",
  ZOEKT_HOT_DIR: "/hot",
  REPO_CACHE_DIR: "/cache",
}))

import { ZoektWarmupTimeoutError } from "../domain/zoekt/warmup.js"
import { registerSearchRoutes } from "./search.js"

function createTestApp(
  db: { select: ReturnType<typeof vi.fn> },
  auth: VerifiedToken = {
    sub: "user_test",
    orgId: "org_mock123",
    principal: "user",
  },
) {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("db", db as unknown as AppEnv["Variables"]["db"])
    c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
    c.set("auth", auth)
    await next()
  })
  registerSearchRoutes(app)
  return app
}

function mockDb(
  rows: Array<{ orgId: string; repoId: string; zoektRepoId: number }>,
) {
  const where = vi.fn().mockResolvedValue(rows)
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ innerJoin })
  const select = vi.fn().mockReturnValue({ from })
  return {
    select,
    where,
    transaction: async (
      fn: (tx: { select: typeof select; execute: () => Promise<void> }) => unknown,
    ) => fn({ select, execute: async () => undefined }),
  }
}

describe("POST /search", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pinReposMock.mockResolvedValue([
      {
        zoektRepoId: 1,
        zoektName: zoektRepositoryName({
          orgId: "org_mock123",
          repoId: "repo_alpha",
        }),
        shardCount: 1,
      },
    ])
    waitUntilMock.mockResolvedValue(undefined)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            Result: { Files: [], MatchCount: 0, ShardsScanned: 1 },
          }),
          { status: 200 },
        ),
      ),
    )
  })

  it("pins repos and waits for Zoekt warmup before searching", async () => {
    const db = mockDb([
      { orgId: "org_mock123", repoId: "repo_alpha", zoektRepoId: 1 },
    ])
    const app = createTestApp(db)

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: "needle", RepoIDs: [1] }),
    })

    expect(res.status).toBe(200)
    expect(pinReposMock).toHaveBeenCalledWith([
      {
        zoektRepoId: 1,
        zoektName: zoektRepositoryName({
          orgId: "org_mock123",
          repoId: "repo_alpha",
        }),
      },
    ])
    expect(waitUntilMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoIds: [1] }),
    )
    expect(fetch).toHaveBeenCalledWith(
      "http://zoekt.test/api/search",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("skips warmup wait when no cold shards were pinned", async () => {
    pinReposMock.mockResolvedValue([
      {
        zoektRepoId: 1,
        zoektName: zoektRepositoryName({
          orgId: "org_mock123",
          repoId: "repo_alpha",
        }),
        shardCount: 0,
      },
    ])
    const db = mockDb([
      { orgId: "org_mock123", repoId: "repo_alpha", zoektRepoId: 1 },
    ])
    const app = createTestApp(db)

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: "needle", RepoIDs: [1] }),
    })

    expect(res.status).toBe(200)
    expect(waitUntilMock).not.toHaveBeenCalled()
  })

  it("returns 503 when warmup times out", async () => {
    waitUntilMock.mockRejectedValue(
      new ZoektWarmupTimeoutError("Zoekt did not load repo ids [1]"),
    )
    const db = mockDb([
      { orgId: "org_mock123", repoId: "repo_alpha", zoektRepoId: 1 },
    ])
    const app = createTestApp(db)

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: "needle", RepoIDs: [1] }),
    })

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("did not load"),
    })
  })

  it("pins same-name repositories with distinct stable identities", async () => {
    pinReposMock.mockResolvedValue([
      {
        zoektRepoId: 1,
        zoektName: zoektRepositoryName({
          orgId: "org_mock123",
          repoId: "repo_alpha",
        }),
        shardCount: 1,
      },
      {
        zoektRepoId: 2,
        zoektName: zoektRepositoryName({
          orgId: "org_mock123",
          repoId: "repo_beta",
        }),
        shardCount: 1,
      },
    ])
    const db = mockDb([
      { orgId: "org_mock123", repoId: "repo_alpha", zoektRepoId: 1 },
      { orgId: "org_mock123", repoId: "repo_beta", zoektRepoId: 2 },
    ])
    const app = createTestApp(db)

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: "needle" }),
    })

    expect(res.status).toBe(200)
    expect(pinReposMock).toHaveBeenCalledWith([
      {
        zoektRepoId: 1,
        zoektName: zoektRepositoryName({
          orgId: "org_mock123",
          repoId: "repo_alpha",
        }),
      },
      {
        zoektRepoId: 2,
        zoektName: zoektRepositoryName({
          orgId: "org_mock123",
          repoId: "repo_beta",
        }),
      },
    ])
    expect(fetch).toHaveBeenCalledWith(
      "http://zoekt.test/api/search",
      expect.objectContaining({
        body: JSON.stringify({ Q: "needle", RepoIDs: [1, 2] }),
      }),
    )
  })

  it("uses only the JWT workspace checkout identity", async () => {
    pinReposMock.mockResolvedValue([
      {
        zoektRepoId: 1,
        zoektName: zoektRepositoryName({
          orgId: "org_mock123",
          repoId: "repo_alpha",
          checkoutKey: "ws:ws_alpha",
        }),
        shardCount: 1,
      },
    ])
    const db = mockDb([
      { orgId: "org_mock123", repoId: "repo_alpha", zoektRepoId: 1 },
    ])
    const app = createTestApp(db, {
      sub: "user_test",
      orgId: "org_mock123",
      principal: "user",
      workspaceId: "ws_alpha",
    })

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Q: "needle",
        RepoIDs: [1],
        checkoutKey: "ws:ws_beta",
      }),
    })

    expect(res.status).toBe(200)
    expect(pinReposMock).toHaveBeenCalledWith([
      {
        zoektRepoId: 1,
        zoektName: zoektRepositoryName({
          orgId: "org_mock123",
          repoId: "repo_alpha",
          checkoutKey: "ws:ws_alpha",
        }),
      },
    ])
  })

  it("does not fall back when the JWT workspace has no checkout rows", async () => {
    const db = mockDb([])
    const app = createTestApp(db, {
      sub: "user_test",
      orgId: "org_mock123",
      principal: "user",
      workspaceId: "ws_missing",
    })

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: "needle" }),
    })

    expect(res.status).toBe(200)
    expect(pinReposMock).toHaveBeenCalledWith([])
    expect(fetch).toHaveBeenCalledWith(
      "http://zoekt.test/api/search",
      expect.objectContaining({
        body: JSON.stringify({ Q: "needle", RepoIDs: [] }),
      }),
    )
  })
})
