import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { zoektRepositoryName } from "../domain/zoekt/shardPrefix.js"

const { pinReposMock, waitUntilMock, warnMock } = vi.hoisted(() => ({
  pinReposMock: vi.fn(),
  waitUntilMock: vi.fn(),
  warnMock: vi.fn(),
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

vi.mock("../observability/logger.js", () => ({
  getLogger: () => ({
    warn: warnMock,
    error: vi.fn(),
    info: vi.fn(),
  }),
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock("../config/paths.js", () => ({
  ZOEKT_WEBSERVER_URL: "http://zoekt.test",
  ZOEKT_INDEX_DIR: "/cold",
  ZOEKT_HOT_DIR: "/hot",
  REPO_CACHE_DIR: "/cache",
}))

import { ZoektWarmupTimeoutError } from "../domain/zoekt/warmup.js"
import { registerSearchRoutes } from "./search.js"

function createTestApp(db: { select: ReturnType<typeof vi.fn> }) {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("db", db as unknown as AppEnv["Variables"]["db"])
    c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
    c.set("auth", {
      sub: "user_test",
      orgId: "org_mock123",
      principal: "user",
    } as AppEnv["Variables"]["auth"])
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
  return { select, where }
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

  it("returns 400 when Zoekt rejects the query", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("parse error: unexpected token", { status: 400 }),
        ),
    )
    const db = mockDb([
      { orgId: "org_mock123", repoId: "repo_alpha", zoektRepoId: 1 },
    ])
    const app = createTestApp(db)

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: "file:((", RepoIDs: [1] }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: "Zoekt rejected the query: parse error: unexpected token",
    })
    expect(warnMock).toHaveBeenCalledWith("codesearch.search.zoekt_rejected", {
      step: "codesearch.search.zoekt_rejected",
      "upstream.status_code": 400,
      error: "zoekt_query_rejected",
    })
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain("file:((")
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain("parse error")
  })

  it("returns 400 with Zoekt's JSON error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "query too complex" }), {
          status: 422,
        }),
      ),
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

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: "Zoekt rejected the query: query too complex",
    })
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain(
      "query too complex",
    )
    expect(warnMock).toHaveBeenCalledWith(
      "codesearch.search.zoekt_rejected",
      expect.objectContaining({
        error: "zoekt_query_rejected",
        "upstream.status_code": 422,
      }),
    )
  })

  it("returns 503 when Zoekt is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 })),
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
    await expect(res.json()).resolves.toEqual({
      error: "Zoekt webserver is unavailable (HTTP 502)",
    })
  })

  it("returns 503 when the Zoekt request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
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
    await expect(res.json()).resolves.toEqual({
      error: "Zoekt webserver is unavailable",
    })
  })
})
