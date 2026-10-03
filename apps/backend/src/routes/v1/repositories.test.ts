import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"

const createOrGetRepositoryMock = vi.hoisted(() => vi.fn())
const getRepositoryMock = vi.hoisted(() => vi.fn())
const enqueueIngestionMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)
const enqueueDeletionMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ jobId: "run_1", status: "queued" }),
)

vi.mock("../../models/repositories.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../models/repositories.js")>()
  return {
    ...actual,
    createOrGetRepository: createOrGetRepositoryMock,
    getRepository: getRepositoryMock,
  }
})

vi.mock("../../openworkflow/enqueue-repository-ingestion.js", () => ({
  enqueueRepositoryIngestionWorkflow: enqueueIngestionMock,
}))

vi.mock("../../openworkflow/enqueue-repository-deletion.js", () => ({
  enqueueRepositoryDeletionWorkflow: enqueueDeletionMock,
}))

import { repositoryRoutes } from "./repositories.js"

function appWithAuth(options?: { orgSlug?: string }) {
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
    if (options?.orgSlug) c.set("orgSlug", options.orgSlug)
    await next()
  })
  app.route("/repositories", repositoryRoutes)
  return app
}

const createdRepository = {
  id: "repo_ABC",
  orgId: "org_mock123",
  zoektRepoId: 123,
  name: "ctxpipe",
  gitUrl: "https://github.com/appear/ctxpipe.git",
  indexReady: false,
  indexingStatus: "queued" as const,
  indexingError: null,
  indexingFailedAt: null,
  indexingReason: null,
  indexingStep: null,
  indexingStepTotal: null,
  indexingStepKey: null,
  lastIngestedHash: null,
  lastIngestedAt: null,
  createdAt: new Date("2026-02-21T10:00:00.000Z"),
  updatedAt: new Date("2026-02-21T10:00:00.000Z"),
}

describe("POST /api/v1/repositories", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    enqueueIngestionMock.mockResolvedValue(undefined)
    getRepositoryMock.mockResolvedValue(null)
  })

  it("creates repository and triggers ingestion workflow", async () => {
    createOrGetRepositoryMock.mockResolvedValue({
      repository: createdRepository,
      created: true,
    })

    const app = appWithAuth()
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
    const body = await res.json()
    expect(body).toMatchObject({
      id: "repo_ABC",
      indexingStep: null,
      indexingStepTotal: null,
      indexingStepKey: null,
    })
    expect(createOrGetRepositoryMock).toHaveBeenCalledWith({
      name: "ctxpipe",
      gitUrl: "https://github.com/appear/ctxpipe.git",
    })
    expect(enqueueIngestionMock).toHaveBeenCalledWith(
      { repositoryId: "repo_ABC", orgId: "org_mock123" },
      expect.any(Object),
    )
  })

  it("returns indexingStep fields when set", async () => {
    createOrGetRepositoryMock.mockResolvedValue({
      repository: {
        ...createdRepository,
        indexingStatus: "running",
        indexingStep: 7,
        indexingStepTotal: 22,
        indexingStepKey: "embedding",
      },
      created: true,
    })

    const app = appWithAuth()
    const res = await app.request("/repositories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "ctxpipe",
        gitUrl: "https://github.com/appear/ctxpipe.git",
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({
      indexingStep: 7,
      indexingStepTotal: 22,
      indexingStepKey: "embedding",
    })
  })

  it("returns 500 when createRepository fails", async () => {
    createOrGetRepositoryMock.mockRejectedValue(new Error("create failed"))

    const app = appWithAuth()
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
    expect(enqueueIngestionMock).not.toHaveBeenCalled()
  })

  it("returns 200 for an existing repository that is not being deleted", async () => {
    createOrGetRepositoryMock.mockResolvedValue({
      repository: createdRepository,
      created: false,
    })

    const app = appWithAuth()
    const res = await app.request("/repositories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "ctxpipe",
        gitUrl: "https://github.com/appear/ctxpipe.git",
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ id: "repo_ABC" })
    expect(enqueueIngestionMock).toHaveBeenCalledWith(
      { repositoryId: "repo_ABC", orgId: "org_mock123" },
      expect.any(Object),
    )
  })

  it("returns 409 when the existing repository is being deleted", async () => {
    createOrGetRepositoryMock.mockResolvedValue({
      repository: {
        ...createdRepository,
        indexingStatus: "unindexing",
      },
      created: false,
    })

    const app = appWithAuth()
    const res = await app.request("/repositories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "ctxpipe",
        gitUrl: "https://github.com/appear/ctxpipe.git",
      }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "Repository is being deleted" })
    expect(enqueueIngestionMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/repositories/:id/reindex", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    enqueueIngestionMock.mockResolvedValue(undefined)
  })

  it("enqueues manual reindex for an existing repository", async () => {
    getRepositoryMock.mockResolvedValue({
      ...createdRepository,
      indexingStatus: "failed",
      indexingError: "codesearch failed",
      indexingFailedAt: new Date("2026-02-21T10:00:00.000Z"),
    })

    const app = appWithAuth()

    const res = await app.request("/repositories/repo_ABC/reindex", {
      method: "POST",
    })

    expect(res.status).toBe(202)
    expect(getRepositoryMock).toHaveBeenCalledWith("repo_ABC")
    expect(enqueueIngestionMock).toHaveBeenCalledWith(
      {
        repositoryId: "repo_ABC",
        orgId: "org_mock123",
        indexingReason: "manual",
        fullReingest: true,
      },
      expect.any(Object),
    )
  })
})

describe("DELETE /api/v1/repositories/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    enqueueDeletionMock.mockResolvedValue({ jobId: "run_1", status: "queued" })
  })

  it("returns 202 and enqueues durable deletion from the loaded repository", async () => {
    getRepositoryMock.mockResolvedValue({
      ...createdRepository,
      indexingStatus: "ready",
    })

    const app = appWithAuth({ orgSlug: "acme" })

    const res = await app.request("/repositories/repo_ABC", {
      method: "DELETE",
    })

    expect(res.status).toBe(202)
    expect(getRepositoryMock).toHaveBeenCalledWith("repo_ABC")
    expect(enqueueDeletionMock).toHaveBeenCalledWith(
      {
        repositoryId: "repo_ABC",
        orgId: "org_mock123",
        repoName: "ctxpipe",
        zoektRepoId: 123,
      },
      expect.any(Object),
    )
  })

  it("returns 404 when repository is not found", async () => {
    getRepositoryMock.mockResolvedValue(null)

    const app = appWithAuth({ orgSlug: "acme" })

    const res = await app.request("/repositories/repo_missing", {
      method: "DELETE",
    })

    expect(res.status).toBe(404)
    expect(enqueueDeletionMock).not.toHaveBeenCalled()
  })

  it("returns 404 when enqueue reports the row is already gone", async () => {
    getRepositoryMock.mockResolvedValue({
      ...createdRepository,
      indexingStatus: "unindexing",
    })
    enqueueDeletionMock.mockResolvedValue(null)

    const app = appWithAuth({ orgSlug: "acme" })

    const res = await app.request("/repositories/repo_ABC", {
      method: "DELETE",
    })

    expect(res.status).toBe(404)
  })
})
