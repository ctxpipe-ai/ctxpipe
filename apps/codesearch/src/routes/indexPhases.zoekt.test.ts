import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY } from "../domain/indexing/memoryFitError.js"

const phaseZoektMock = vi.hoisted(() => vi.fn())
const getAccessibleRepositoryMock = vi.hoisted(() => vi.fn())
const getIndexableRepositoryMock = vi.hoisted(() => vi.fn())

vi.mock("../domain/indexing/phases.js", async () => {
  const actual = await vi.importActual<
    typeof import("../domain/indexing/phases.js")
  >("../domain/indexing/phases.js")
  return {
    ...actual,
    phaseZoekt: phaseZoektMock,
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

import { errorFromIndexerExit } from "../domain/indexing/memoryFitError.js"
import { registerIndexPhaseRoutes } from "./indexPhases.js"

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

describe("POST /{repoId}/index/zoekt", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAccessibleRepositoryMock.mockResolvedValue({
      id: "repo_aaaaaa",
      orgId: "org_mock123",
      name: "acme/web",
      gitUrl: "https://github.com/acme/web.git",
    })
    getIndexableRepositoryMock.mockResolvedValue({
      id: "repo_aaaaaa",
      orgId: "org_mock123",
      name: "acme/web",
      gitUrl: "https://github.com/acme/web.git",
      zoektRepoId: 1,
    })
  })

  it("returns the canonical memory-fit error when zoekt-index is SIGKILL'd", async () => {
    phaseZoektMock.mockRejectedValue(
      errorFromIndexerExit({
        exitCode: 137,
        stderr: "Killed",
        stdout: "",
        headline: "Command failed with exit code 137",
      }),
    )
    const app = createTestApp()
    const res = await app.request("/repo_aaaaaa/index/zoekt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY,
    })
  })
})
