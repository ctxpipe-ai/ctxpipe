import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { initLogger } from "evlog"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { AppEnv } from "../app/env.js"
import {
  zoektRepositoryName,
  zoektShardFilePrefix,
} from "../domain/zoekt/shardPrefix.js"
import { flushEvlog } from "../observability/logger.js"
import { codesearchSpanProcessors } from "../observability/otel.js"

const zoektBase = "http://zoekt.test"
const zoektSearch = `${zoektBase}/api/search`
const zoektList = `${zoektBase}/api/list`
const otlpLogsUrl = "http://127.0.0.1:4318/v1/logs"
const otlpBodies: unknown[] = []
let lastSearchBody = ""
let listCalls = 0
let tmpDir = ""
let indexDir = ""
let hotDir = ""

let useObservability: typeof import("../app/app.js")["useObservability"]
let registerSearchRoutes: typeof import("./search.js")["registerSearchRoutes"]
let resetPinManagerForTests: typeof import("../domain/zoekt/pinManager.js")["resetPinManagerForTests"]

const server = setupServer()
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    ...codesearchSpanProcessors(),
    new SimpleSpanProcessor(exporter),
  ],
})

const alpha = {
  orgId: "org_mock123",
  repoId: "repo_alpha",
}
const beta = {
  orgId: "org_mock123",
  repoId: "repo_beta",
}

function zoektJson() {
  return HttpResponse.json({
    Result: { Files: [], MatchCount: 0, ShardsScanned: 1 },
  })
}

function otlpLogEvents(): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const body of otlpBodies) {
    const resourceLogs =
      (
        body as {
          resourceLogs?: Array<{
            scopeLogs?: Array<{
              logRecords?: Array<{ body?: { stringValue?: string } }>
            }>
          }>
        }
      ).resourceLogs ?? []
    for (const resourceLog of resourceLogs) {
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        for (const record of scopeLog.logRecords ?? []) {
          const raw = record.body?.stringValue
          if (!raw) continue
          events.push(JSON.parse(raw) as Record<string, unknown>)
        }
      }
    }
  }
  return events
}

function createTestApp(db: { select: ReturnType<typeof vi.fn> }) {
  const app = new OpenAPIHono<AppEnv>()
  useObservability(app)
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

async function writeColdShard(zoektName: string): Promise<string> {
  const basename = `${zoektShardFilePrefix(zoektName)}v16.00000.zoekt`
  await writeFile(join(indexDir, basename), "")
  return basename
}

describe("POST /search", () => {
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesearch-search-"))
    indexDir = join(tmpDir, "zoekt-index")
    await mkdir(indexDir, { recursive: true })
    vi.stubEnv("ZOEKT_INDEX_DIR", indexDir)
    vi.stubEnv("ZOEKT_WEBSERVER_URL", zoektBase)
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-at-least-32-characters")
    vi.stubEnv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", otlpLogsUrl)
    const appMod = await import("../app/app.js")
    const searchMod = await import("./search.js")
    const pinMod = await import("../domain/zoekt/pinManager.js")
    const paths = await import("../config/paths.js")
    useObservability = appMod.useObservability
    registerSearchRoutes = searchMod.registerSearchRoutes
    resetPinManagerForTests = pinMod.resetPinManagerForTests
    hotDir = paths.ZOEKT_HOT_DIR
    expect(paths.ZOEKT_INDEX_DIR).toBe(indexDir)
    expect(paths.ZOEKT_WEBSERVER_URL).toBe(zoektBase)

    provider.register()
    initLogger({
      env: { service: "codesearch", environment: "test" },
      pretty: false,
      silent: true,
      drain: () => {},
    })
    server.listen({ onUnhandledRequest: "error" })
  })

  beforeEach(async () => {
    resetPinManagerForTests()
    await rm(indexDir, { recursive: true, force: true })
    await rm(hotDir, { recursive: true, force: true })
    await mkdir(indexDir, { recursive: true })
    exporter.reset()
    otlpBodies.length = 0
    lastSearchBody = ""
    listCalls = 0
    server.resetHandlers()
    server.use(
      http.post(otlpLogsUrl, async ({ request }) => {
        otlpBodies.push(await request.json())
        return HttpResponse.json({})
      }),
      http.post(zoektList, () => {
        listCalls += 1
        return HttpResponse.json({
          List: {
            Repos: [1, 2].map((id) => ({ Repository: { ID: id } })),
          },
        })
      }),
      http.post(zoektSearch, async ({ request }) => {
        lastSearchBody = await request.text()
        return zoektJson()
      }),
    )
  })

  afterEach(async () => {
    resetPinManagerForTests()
    await flushEvlog()
  })

  afterAll(async () => {
    resetPinManagerForTests()
    server.close()
    await provider.shutdown()
    await rm(tmpDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it("pins repos and waits for Zoekt warmup before searching", async () => {
    const basename = await writeColdShard(zoektRepositoryName(alpha))
    const db = mockDb([{ ...alpha, zoektRepoId: 1 }])
    const app = createTestApp(db)

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: "needle", RepoIDs: [1] }),
    })

    expect(res.status).toBe(200)
    expect(await readlink(join(hotDir, basename))).toBe(
      join(indexDir, basename),
    )
    expect(listCalls).toBeGreaterThan(0)
    expect(lastSearchBody).toBe(JSON.stringify({ Q: "needle", RepoIDs: [1] }))
  })

  it("skips warmup wait when no cold shards were pinned", async () => {
    const db = mockDb([{ ...alpha, zoektRepoId: 1 }])
    const app = createTestApp(db)

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: "needle", RepoIDs: [1] }),
    })

    expect(res.status).toBe(200)
    expect(listCalls).toBe(0)
    expect(lastSearchBody).toBe(JSON.stringify({ Q: "needle", RepoIDs: [1] }))
  })

  it("returns 503 when warmup times out", async () => {
    await writeColdShard(zoektRepositoryName(alpha))
    server.use(
      http.post(zoektList, () => {
        listCalls += 1
        return HttpResponse.json({ List: { Repos: [] } })
      }),
    )
    const db = mockDb([{ ...alpha, zoektRepoId: 1 }])
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
  }, 20_000)

  it("pins same-name repositories with distinct stable identities", async () => {
    const alphaShard = await writeColdShard(zoektRepositoryName(alpha))
    const betaShard = await writeColdShard(zoektRepositoryName(beta))
    const db = mockDb([
      { ...alpha, zoektRepoId: 1 },
      { ...beta, zoektRepoId: 2 },
    ])
    const app = createTestApp(db)

    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q: "needle" }),
    })

    expect(res.status).toBe(200)
    expect(await readlink(join(hotDir, alphaShard))).toBe(
      join(indexDir, alphaShard),
    )
    expect(await readlink(join(hotDir, betaShard))).toBe(
      join(indexDir, betaShard),
    )
    expect(lastSearchBody).toBe(
      JSON.stringify({ Q: "needle", RepoIDs: [1, 2] }),
    )
  })

  it("returns 400 when Zoekt rejects the query and keeps the query out of logs and spans", async () => {
    await writeColdShard(zoektRepositoryName(alpha))
    const query = "ZQPROBE_file_paren_secret"
    server.use(
      http.post(zoektSearch, () => {
        return new HttpResponse(`parse error: ${query}`, { status: 400 })
      }),
    )
    const db = mockDb([{ ...alpha, zoektRepoId: 1 }])
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
    await flushEvlog()
    const events = otlpLogEvents()
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: "codesearch.search.zoekt_rejected",
          "upstream.status_code": 400,
          error: "zoekt_query_rejected",
        }),
      ]),
    )
    expect(JSON.stringify(otlpBodies)).not.toContain(query)
    expect(JSON.stringify(otlpBodies)).not.toContain("parse error")

    const span = exporter
      .getFinishedSpans()
      .find((item) => item.name.startsWith("POST"))
    expect(span?.name).toBe("POST /search")
    expect(span?.attributes["http.response.status_code"]).toBe(400)
    expect(JSON.stringify(span?.attributes ?? {})).not.toContain(query)
    expect(JSON.stringify(span?.events ?? [])).not.toContain(query)
  })

  it("returns 400 and logs the upstream status for Zoekt plain-text errors", async () => {
    await writeColdShard(zoektRepositoryName(alpha))
    server.use(
      http.post(
        zoektSearch,
        () => new HttpResponse("query too complex\n", { status: 422 }),
      ),
    )
    const db = mockDb([{ ...alpha, zoektRepoId: 1 }])
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
    await flushEvlog()
    const events = otlpLogEvents()
    expect(JSON.stringify(otlpBodies)).not.toContain("query too complex")
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
    await writeColdShard(zoektRepositoryName(alpha))
    server.use(
      http.post(
        zoektSearch,
        () => new HttpResponse("bad gateway", { status: 502 }),
      ),
    )
    const db = mockDb([{ ...alpha, zoektRepoId: 1 }])
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
    await writeColdShard(zoektRepositoryName(alpha))
    server.use(http.post(zoektSearch, () => HttpResponse.error()))
    const db = mockDb([{ ...alpha, zoektRepoId: 1 }])
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
