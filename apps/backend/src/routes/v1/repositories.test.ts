import { beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"

const {
  createRepositoryMock,
  resolveRepositoryRefMock,
  enqueueRepositoryIngestionMock,
} = vi.hoisted(() => ({
  createRepositoryMock: vi.fn(),
  resolveRepositoryRefMock: vi.fn(),
  enqueueRepositoryIngestionMock: vi.fn(),
}))

vi.mock("../../models/repositories.js", () => ({
  createRepository: createRepositoryMock,
}))

vi.mock("../../domain/codeIngestion/queue.js", () => ({
  resolveRepositoryRef: resolveRepositoryRefMock,
  enqueueRepositoryIngestion: enqueueRepositoryIngestionMock,
}))

import { repositoryRoutes } from "./repositories.js"

describe("POST /api/v1/repositories", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("creates repository and enqueues ingestion from default branch", async () => {
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
    resolveRepositoryRefMock.mockResolvedValue({
      branch: "main",
      hash: "abc123",
    })
    enqueueRepositoryIngestionMock.mockResolvedValue({
      id: "ingq_XYZ",
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
    expect(resolveRepositoryRefMock).toHaveBeenCalledWith({
      repositoryId: "repo_ABC",
      orgId: "org_mock123",
    })
    expect(enqueueRepositoryIngestionMock).toHaveBeenCalledWith({
      repositoryId: "repo_ABC",
      orgId: "org_mock123",
      targetHash: "abc123",
      sourceBranch: "main",
      fromHash: null,
    })
  })

  it("returns 500 when ref resolution fails", async () => {
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
    resolveRepositoryRefMock.mockRejectedValue(new Error("resolve failed"))

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
    expect(enqueueRepositoryIngestionMock).not.toHaveBeenCalled()
  })

  it("returns 500 when enqueue fails", async () => {
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
    resolveRepositoryRefMock.mockResolvedValue({
      branch: "main",
      hash: "abc123",
    })
    enqueueRepositoryIngestionMock.mockRejectedValue(new Error("enqueue failed"))

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
  })
})
