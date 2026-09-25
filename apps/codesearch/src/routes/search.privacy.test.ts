import { OpenAPIHono } from "@hono/zod-openapi"
import { trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { contextStorage } from "hono/context-storage"
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
import { applyCodesearchLogContract } from "../observability/logger.js"
import { codesearchOtelMiddleware } from "../observability/otel.js"

const { pinReposMock, waitUntilMock } = vi.hoisted(() => ({
  pinReposMock: vi.fn(),
  waitUntilMock: vi.fn(),
}))

vi.mock("../domain/zoekt/pinManager.js", () => ({
  pinRepos: pinReposMock,
}))

vi.mock("../domain/zoekt/warmup.js", () => ({
  waitUntilZoektReposLoaded: waitUntilMock,
  ZoektWarmupTimeoutError: class ZoektWarmupTimeoutError extends Error {},
}))

vi.mock("../config/paths.js", () => ({
  ZOEKT_WEBSERVER_URL: "http://zoekt.test",
  ZOEKT_INDEX_DIR: "/cold",
  ZOEKT_HOT_DIR: "/hot",
  REPO_CACHE_DIR: "/cache",
}))

import { registerSearchRoutes } from "./search.js"

const query = "ZQPROBE_file_paren_secret"
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

beforeAll(() => {
  provider.register()
})

afterAll(async () => {
  await provider.shutdown()
})

function mockDb(
  rows: Array<{ orgId: string; repoId: string; zoektRepoId: number }>,
) {
  const where = vi.fn().mockResolvedValue(rows)
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ innerJoin })
  const select = vi.fn().mockReturnValue({ from })
  return { select }
}

describe("POST /search rejection privacy", () => {
  beforeEach(() => {
    exporter.reset()
    pinReposMock.mockResolvedValue([
      { zoektRepoId: 1, zoektName: "org/repo", shardCount: 0 },
    ])
    waitUntilMock.mockResolvedValue(undefined)
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(`parse error: ${query}`, { status: 400 }),
        ),
    )
  })

  it("returns Zoekt's message and keeps it out of the wide event and span", async () => {
    initLogger({
      env: { service: "codesearch", environment: "test" },
      pretty: false,
    })
    const events: Record<string, unknown>[] = []
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", codesearchOtelMiddleware())
    app.use("*", async (c, next) => {
      c.set(
        "db",
        mockDb([
          { orgId: "org_mock123", repoId: "repo_alpha", zoektRepoId: 1 },
        ]) as unknown as AppEnv["Variables"]["db"],
      )
      c.set("env", {
        NODE_ENV: "test",
        PORT: 3001,
      } as AppEnv["Variables"]["env"])
      c.set("auth", {
        sub: "user_test",
        orgId: "org_mock123",
        principal: "user",
      })
      await next()
    })
    app.use("*", contextStorage())
    app.use(
      evlog({
        enrich: (ctx) => {
          applyCodesearchLogContract(ctx.event as Record<string, unknown>)
        },
        drain: async (ctx) => {
          const batch = Array.isArray(ctx) ? ctx : [ctx]
          for (const item of batch) {
            events.push(item.event as Record<string, unknown>)
          }
        },
      }),
    )
    registerSearchRoutes(app)

    const res = await app.request("http://codesearch.test/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: query, RepoIDs: [1] }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: `Zoekt rejected the query: parse error: ${query}`,
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      status: 400,
      error: "zoekt_query_rejected",
      step: "codesearch.search.zoekt_rejected",
    })
    expect(JSON.stringify(events)).not.toContain(query)
    expect(JSON.stringify(events)).not.toContain("parse error")

    const span = exporter
      .getFinishedSpans()
      .find((item) => item.name.startsWith("POST"))
    expect(span?.attributes["http.response.status_code"]).toBe(400)
    expect(span?.status.message ?? "").toBe("")
    expect(JSON.stringify(span?.events ?? [])).not.toContain(query)
    expect(JSON.stringify(span?.attributes ?? {})).not.toContain(query)
    expect(trace.getActiveSpan()).toBeUndefined()
  })
})
