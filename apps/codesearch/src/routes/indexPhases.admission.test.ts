import { OpenAPIHono } from "@hono/zod-openapi"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { resetIndexPipelineAdmissionForTests } from "../domain/indexing/indexPipelineAdmission.js"

const phaseCloneCheckoutMock = vi.hoisted(() => vi.fn())
const getAccessibleRepositoryMock = vi.hoisted(() => vi.fn())
const getIndexableRepositoryMock = vi.hoisted(() => vi.fn())

vi.mock("../domain/indexing/phases.js", async () => {
  const actual = await vi.importActual<
    typeof import("../domain/indexing/phases.js")
  >("../domain/indexing/phases.js")
  return {
    ...actual,
    phaseCloneCheckout: phaseCloneCheckoutMock,
  }
})

vi.mock("../domain/repositories/service.js", () => ({
  getAccessibleRepository: getAccessibleRepositoryMock,
  getIndexableRepository: getIndexableRepositoryMock,
}))

vi.mock("../observability/logger.js", () => ({
  createLogger: () => ({}),
  withLogger: (_logger: unknown, fn: () => unknown) => fn(),
  getLogger: () => ({ set: vi.fn(), info: vi.fn() }),
  flushWorkflowLog: vi.fn(),
}))

import { registerIndexPhaseRoutes } from "./indexPhases.js"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function repo(id: string) {
  return {
    id,
    orgId: "org_mock123",
    name: `acme/${id}`,
    gitUrl: `https://github.com/acme/${id}.git`,
    zoektRepoId: 1,
  }
}

function createTestApp() {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("db", {} as AppEnv["Variables"]["db"])
    c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
    c.set("auth", {
      sub: "svc",
      orgId: "org_mock123",
      principal: "service",
    } as AppEnv["Variables"]["auth"])
    await next()
  })
  registerIndexPhaseRoutes(app)
  return app
}

describe("index phase pipeline admission", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetIndexPipelineAdmissionForTests()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetIndexPipelineAdmissionForTests()
    getAccessibleRepositoryMock.mockImplementation(
      async (_db, repoId: string) => repo(repoId),
    )
    getIndexableRepositoryMock.mockImplementation(async (_db, repoId: string) =>
      repo(repoId),
    )
  })

  it("returns 429 with Retry-After when another repo holds the pipeline cap", async () => {
    vi.stubEnv("CODESEARCH_INDEX_PIPELINE_CONCURRENCY", "1")
    const hold = deferred()
    phaseCloneCheckoutMock.mockImplementation(async () => {
      await hold.promise
      return {
        targetHash: "abc",
        ingestMode: "full",
        changedPaths: [],
        deletedPaths: [],
        renames: [],
      }
    })
    const app = createTestApp()
    const first = app.request("/repo_aaaaaa/index/clone-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    await vi.waitFor(() => expect(phaseCloneCheckoutMock).toHaveBeenCalled())

    const second = await app.request("/repo_bbbbbb/index/clone-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(second.status).toBe(429)
    expect(second.headers.get("Retry-After")).toBe("30")
    await expect(second.json()).resolves.toEqual({
      error: "Index pipeline capacity exceeded",
    })

    hold.resolve()
    expect((await first).status).toBe(200)
  })
})
