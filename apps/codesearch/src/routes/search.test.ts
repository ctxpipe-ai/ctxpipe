import { httpInstrumentationMiddleware } from "@hono/otel"
import { OpenAPIHono } from "@hono/zod-openapi"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { contextStorage } from "hono/context-storage"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { AppEnv } from "../app/env.js"
import { zoektRepositoryName } from "../domain/zoekt/shardPrefix.js"
import { applyCodesearchLogContract } from "../observability/logger.js"
import { codesearchSpanProcessors } from "../observability/otel.js"

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

const zoektSearch = "http://zoekt.test/api/search"
const events: Record<string, unknown>[] = []
let lastSearchBody = ""

const server = setupServer()
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    ...codesearchSpanProcessors(),
    new SimpleSpanProcessor(exporter),
  ],
})

function zoektJson() {
  return HttpResponse.json({
    Result: { Files: [], MatchCount: 0, ShardsScanned: 1 },
  })
}

function createTestApp(db: { select: ReturnType<typeof vi.fn> }) {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", httpInstrumentationMiddleware({ serviceName: "codesearch" }))
  app.use("*", contextStorage())
  app.use(
    evlog({
      enrich: (ctx) => {
        applyCodesearchLogContract(ctx.event as Record<string, unknown>)
      },
      drain: (ctx) => {
        const batch = Array.isArray(ctx) ? ctx : [ctx]
        for (const item of batch) {
          events.push(item.event as Record<string, unknown>)
        }
      },
    }),
  )
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
  beforeAll(() => {
    provider.register()
    initLogger({
      env: { service: "codesearch", environment: "test" },
      pretty: false,
      silent: true,
      drain: () => {},
    })
    server.listen({ onUnhandledRequest: "error" })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    exporter.reset()
    events.length = 0
    lastSearchBody = ""
    server.resetHandlers()
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
    server.use(
      http.post(zoektSearch, async ({ request }) => {
        lastSearchBody = await request.text()
        return zoektJson()
      }),
    )
  })

  afterAll(async () => {
    server.close()
    await provider.shutdown()
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
    expect(lastSearchBody).toBe(JSON.stringify({ Q: "needle", RepoIDs: [1] }))
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
    expect(lastSearchBody).toBe(
      JSON.stringify({ Q: "needle", RepoIDs: [1, 2] }),
    )
  })

  it("returns 400 when Zoekt rejects the query and keeps the query out of logs and spans", async () => {
    const query = "ZQPROBE_file_paren_secret"
    server.use(
      http.post(zoektSearch, () => {
        return new HttpResponse(`parse error: ${query}`, { status: 400 })
      }),
    )
    const db = mockDb([
      { orgId: "org_mock123", repoId: "repo_alpha", zoektRepoId: 1 },
    ])
    const app = createTestApp(db)

    const res = await app.request("http://codesearch.test/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: query, RepoIDs: [1] }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: `Zoekt rejected the query: parse error: ${query}`,
      code: "query_rejected",
    })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: "codesearch.search.zoekt_rejected",
          "upstream.status_code": 400,
          error: "zoekt_query_rejected",
        }),
      ]),
    )
    expect(JSON.stringify(events)).not.toContain(query)
    expect(JSON.stringify(events)).not.toContain("parse error")

    const span = exporter
      .getFinishedSpans()
      .find((item) => item.name.startsWith("POST"))
    expect(span?.name).toBe("POST /search")
    expect(span?.attributes["http.response.status_code"]).toBe(400)
    expect(JSON.stringify(span?.attributes ?? {})).not.toContain(query)
    expect(JSON.stringify(span?.events ?? [])).not.toContain(query)
  })

  it("returns 400 and logs the upstream status for Zoekt plain-text errors", async () => {
    server.use(
      http.post(
        zoektSearch,
        () => new HttpResponse("query too complex\n", { status: 422 }),
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
      code: "query_rejected",
    })
    expect(JSON.stringify(events)).not.toContain("query too complex")
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: "zoekt_query_rejected",
          "upstream.status_code": 422,
        }),
      ]),
    )
  })

  it("returns 503 when Zoekt is unavailable", async () => {
    server.use(
      http.post(
        zoektSearch,
        () => new HttpResponse("bad gateway", { status: 502 }),
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

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: "Zoekt webserver is unavailable (HTTP 502)",
    })
  })

  it("returns 503 when the Zoekt request fails", async () => {
    server.use(http.post(zoektSearch, () => HttpResponse.error()))
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
