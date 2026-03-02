import { beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { repositoryIngestion } from "../../openworkflow/repository-ingestion.js"

const createRepositoryMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ workflowRun: { id: "run_1" } }),
)

vi.mock("../../models/repositories.js", () => ({
  createRepository: createRepositoryMock,
}))

vi.mock("../../openworkflow/client.js", () => ({
  ow: { runWorkflow: runWorkflowMock },
}))

import { repositoryRoutes } from "./repositories.js"

describe("POST /api/v1/repositories", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowMock.mockResolvedValue({ workflowRun: { id: "run_1" } })
  })

  it("creates repository and triggers ingestion workflow", async () => {
    createRepositoryMock.mockResolvedValue({
      id: "repo_ABC",
      orgId: "org_mock123",
      zoektRepoId: 123,
      name: "ctxpipe",
      gitUrl: "https://github.com/appear/ctxpipe.git",
      indexReady: false,
      lastIngestedHash: null,
      createdAt: new Date("2026-02-21T10:00:00.000Z"),
      updatedAt: new Date("2026-02-21T10:00:00.000Z"),
    })

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
      await next()
    })
    app.route("/repositories", repositoryRoutes)
    const res = await app.request("/repositories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "ctxpipe",
        gitUrl: "https://github.com/appear/ctxpipe.git",
        orgId: "org_ignored_in_mock_mode",
      }),
    })

    expect(res.status).toBe(201)
    expect(createRepositoryMock).toHaveBeenCalledWith({
      name: "ctxpipe",
      gitUrl: "https://github.com/appear/ctxpipe.git",
    })
    expect(runWorkflowMock).toHaveBeenCalledWith(repositoryIngestion.spec, {
      repositoryId: "repo_ABC",
      orgId: "org_mock123",
    })
  })

  it("returns 500 when createRepository fails", async () => {
    createRepositoryMock.mockRejectedValue(new Error("create failed"))

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
      await next()
    })
    app.route("/repositories", repositoryRoutes)
    const res = await app.request("/repositories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "ctxpipe",
        gitUrl: "https://github.com/appear/ctxpipe.git",
        orgId: "org_ignored_in_mock_mode",
      }),
    })

    expect(res.status).toBe(500)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })
})
