import { OpenAPIHono } from "@hono/zod-openapi"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { resetIndexPipelineAdmissionForTests } from "../domain/indexing/indexPipelineAdmission.js"
import { CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY } from "../domain/indexing/memoryFitError.js"

const phaseScipLanguageMock = vi.hoisted(() => vi.fn())
const phaseMergeScipMock = vi.hoisted(() => vi.fn())
const phaseMarkCheckoutIndexedMock = vi.hoisted(() => vi.fn())
const getAccessibleRepositoryMock = vi.hoisted(() => vi.fn())
const getIndexableRepositoryMock = vi.hoisted(() => vi.fn())

vi.mock("../domain/indexing/phases.js", async () => {
  const actual = await vi.importActual<
    typeof import("../domain/indexing/phases.js")
  >("../domain/indexing/phases.js")
  return {
    ...actual,
    phaseScipLanguage: phaseScipLanguageMock,
    phaseMergeScip: phaseMergeScipMock,
    phaseMarkCheckoutIndexed: phaseMarkCheckoutIndexedMock,
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
import {
  registerIndexPhaseRoutes,
  resetScipPhaseRunsForTests,
} from "./indexPhases.js"

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

describe("POST /{repoId}/index/scip/{lang}", () => {
  afterEach(() => {
    resetIndexPipelineAdmissionForTests()
    resetScipPhaseRunsForTests()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetIndexPipelineAdmissionForTests()
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

  it("accepts a SCIP language phase and reports it on a follow-up read without starting a second index", async () => {
    let finish: (() => void) | undefined
    phaseScipLanguageMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const app = createTestApp()
    const post = () =>
      app.request("/repo_aaaaaa/index/scip/typescript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detectedLanguages: ["typescript"] }),
      })

    const started = await Promise.race([
      post(),
      new Promise<Response>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error("SCIP phase POST blocked until the index finished"),
            ),
          50,
        )
      }),
    ])
    expect(started.status).toBe(202)
    await expect(started.json()).resolves.toEqual({
      ok: true,
      status: "running",
    })
    expect(phaseScipLanguageMock).toHaveBeenCalledTimes(1)

    const again = await post()
    expect(again.status).toBe(202)
    expect(phaseScipLanguageMock).toHaveBeenCalledTimes(1)

    const running = await app.request("/repo_aaaaaa/index/scip/typescript")
    expect(running.status).toBe(200)
    await expect(running.json()).resolves.toEqual({ status: "running" })

    if (!finish) throw new Error("phase did not start")
    finish()
    await vi.waitFor(async () => {
      const done = await app.request("/repo_aaaaaa/index/scip/typescript")
      expect(await done.json()).toEqual({ status: "succeeded" })
    })
  })

  it("returns the canonical memory-fit error when the SCIP indexer is SIGKILL'd", async () => {
    phaseScipLanguageMock.mockRejectedValue(
      errorFromIndexerExit({
        exitCode: 137,
        stderr: "Killed",
        stdout: "",
        headline: "Command failed with exit code 137",
      }),
    )
    const app = createTestApp()
    const res = await app.request("/repo_aaaaaa/index/scip/go", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ detectedLanguages: ["go"] }),
    })
    expect(res.status).toBe(202)
    await vi.waitFor(async () => {
      const status = await app.request("/repo_aaaaaa/index/scip/go")
      expect(await status.json()).toEqual({
        status: "failed",
        error: CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY,
      })
    })
  })
})

describe("POST /{repoId}/index/merge-scip", () => {
  afterEach(() => {
    resetIndexPipelineAdmissionForTests()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetIndexPipelineAdmissionForTests()
    phaseMarkCheckoutIndexedMock.mockResolvedValue(undefined)
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

  it("marks the checkout even when merge throws", async () => {
    phaseMergeScipMock.mockRejectedValue(new Error("SCIP merge failed"))
    const app = createTestApp()
    const res = await app.request("/repo_aaaaaa/index/merge-scip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ detectedLanguages: ["go"] }),
    })
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: "SCIP merge failed",
    })
    expect(phaseMarkCheckoutIndexedMock).toHaveBeenCalledOnce()
  })
})
