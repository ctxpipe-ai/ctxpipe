import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

const { pinReposMock, waitUntilMock } = vi.hoisted(() => ({
  pinReposMock: vi.fn(),
  waitUntilMock: vi.fn(),
}))

vi.mock("../domain/zoekt/pinManager.js", () => ({
  pinRepos: pinReposMock,
}))

vi.mock("../domain/zoekt/warmup.js", async () => {
  const actual = await vi.importActual<typeof import("../domain/zoekt/warmup.js")>(
    "../domain/zoekt/warmup.js",
  )
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

function createTestApp(db: {
  select: ReturnType<typeof vi.fn>
}) {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("db", db as unknown as AppEnv["Variables"]["db"])
    c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
    c.set(
      "auth",
      {
        sub: "user_test",
        orgId: "org_mock123",
        principal: "user",
      } as AppEnv["Variables"]["auth"],
    )
    await next()
  })
  registerSearchRoutes(app)
  return app
}

function mockDb(rows: Array<{ zoektRepoId: number; repoName: string }>) {
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
      { zoektRepoId: 1, repoName: "owner/repo", shardCount: 1 },
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
    const db = mockDb([{ zoektRepoId: 1, repoName: "owner/repo" }])
    const app = createTestApp(db)

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: "needle", RepoIDs: [1] }),
    })

    expect(res.status).toBe(200)
    expect(pinReposMock).toHaveBeenCalledWith([
      { zoektRepoId: 1, repoName: "owner/repo" },
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
      { zoektRepoId: 1, repoName: "owner/repo", shardCount: 0 },
    ])
    const db = mockDb([{ zoektRepoId: 1, repoName: "owner/repo" }])
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
    const db = mockDb([{ zoektRepoId: 1, repoName: "owner/repo" }])
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
})
