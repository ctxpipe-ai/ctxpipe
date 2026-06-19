import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const createRepositoryMock = vi.hoisted(() => vi.fn())
const recordAgentActivityEventMock = vi.hoisted(() => vi.fn())
const enqueueIngestionMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)

vi.mock("../../models/repositories.js", () => ({
  createRepository: createRepositoryMock,
}))

vi.mock("../../models/agent-activity-events.js", () => ({
  recordAgentActivityEvent: recordAgentActivityEventMock,
}))

vi.mock("../../openworkflow/enqueue-repository-ingestion.js", () => ({
  enqueueRepositoryIngestionWorkflow: enqueueIngestionMock,
}))

import { repositoryRoutes } from "./repositories.js"

describe("POST /api/v1/repositories", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    recordAgentActivityEventMock.mockResolvedValue(undefined)
    enqueueIngestionMock.mockResolvedValue(undefined)
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
      c.set("log", {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
      } as unknown as AppEnv["Variables"]["log"])
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
    expect(recordAgentActivityEventMock).toHaveBeenCalledWith({
      orgId: "org_mock123",
      userId: "user_test",
      source: "repository",
      eventType: "repository.created",
      subjectId: "repo_ABC",
      metadata: {
        name: "ctxpipe",
        gitUrl: "https://github.com/appear/ctxpipe.git",
      },
    })
    expect(enqueueIngestionMock).toHaveBeenCalledWith(
      { repositoryId: "repo_ABC", orgId: "org_mock123" },
      expect.any(Object),
    )
  })

  it("returns 500 when createRepository fails", async () => {
    createRepositoryMock.mockRejectedValue(new Error("create failed"))

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
      c.set("log", {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
      } as unknown as AppEnv["Variables"]["log"])
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
    expect(recordAgentActivityEventMock).not.toHaveBeenCalled()
    expect(enqueueIngestionMock).not.toHaveBeenCalled()
  })
})
