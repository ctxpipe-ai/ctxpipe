import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

const {
  getAccessibleRepositoryMock,
  getIndexableRepositoryMock,
  phaseCloneCheckoutMock,
} = vi.hoisted(() => ({
  getAccessibleRepositoryMock: vi.fn(),
  getIndexableRepositoryMock: vi.fn(),
  phaseCloneCheckoutMock: vi.fn(),
}))

vi.mock("../domain/indexing/indexConcurrency.js", () => ({
  withRepositoryIndexOperation: (
    _repoId: string,
    operation: () => Promise<Response>,
  ) => operation(),
}))

vi.mock("../domain/indexing/phases.js", () => ({
  phaseCloneCheckout: phaseCloneCheckoutMock,
  phaseDetectLanguages: vi.fn(),
  phaseMarkCheckoutIndexed: vi.fn(),
  phaseMergeScip: vi.fn(),
  phaseScipLanguage: vi.fn(),
  phaseZoekt: vi.fn(),
}))

vi.mock("../domain/repositories/service.js", () => ({
  getAccessibleRepository: getAccessibleRepositoryMock,
  getIndexableRepository: getIndexableRepositoryMock,
}))

import { registerIndexPhaseRoutes } from "./indexPhases.js"

function createTestApp(workspaceId: string) {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("db", {} as AppEnv["Variables"]["db"])
    c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
    c.set("auth", {
      sub: "repo:repo_abcdef27",
      orgId: "org_mock123",
      principal: "service",
      workspaceId,
    })
    await next()
  })
  registerIndexPhaseRoutes(app)
  return app
}

describe("POST /{repoId}/index/clone-checkout checkout isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAccessibleRepositoryMock.mockResolvedValue({
      id: "repo_abcdef27",
      orgId: "org_mock123",
      name: "repo",
      gitUrl: "https://github.com/ctxpipe/repo.git",
    })
    getIndexableRepositoryMock.mockResolvedValue({
      id: "repo_abcdef27",
      orgId: "org_mock123",
      name: "repo",
      gitUrl: "https://github.com/ctxpipe/repo.git",
      zoektRepoId: 42,
    })
    phaseCloneCheckoutMock.mockResolvedValue({
      targetHash: "abc123",
      ingestMode: "full",
      changedPaths: [],
      deletedPaths: [],
      renames: [],
    })
  })

  it("rejects a checkoutKey that differs from the JWT workspace", async () => {
    const res = await createTestApp("ws_alpha").request(
      "/repo_abcdef27/index/clone-checkout",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkoutKey: "ws:ws_beta" }),
      },
    )

    expect(res.status).toBe(403)
    expect(getIndexableRepositoryMock).not.toHaveBeenCalled()
    expect(phaseCloneCheckoutMock).not.toHaveBeenCalled()
  })

  it("derives the checkout from JWT auth when the request omits checkoutKey", async () => {
    const res = await createTestApp("ws_alpha").request(
      "/repo_abcdef27/index/clone-checkout",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    )

    expect(res.status).toBe(200)
    expect(getIndexableRepositoryMock).toHaveBeenCalledWith(
      expect.anything(),
      "repo_abcdef27",
      "org_mock123",
      "ws:ws_alpha",
    )
    expect(phaseCloneCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutKey: "ws:ws_alpha",
        clonePath: expect.stringContaining(
          "/org_mock123/repo_abcdef27/checkouts/ws:ws_alpha",
        ),
      }),
      expect.anything(),
    )
  })
})
