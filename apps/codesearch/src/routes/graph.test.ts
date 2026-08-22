import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

vi.mock("../config/paths.js", () => ({
  REPO_CACHE_DIR: "/repo-cache",
  ZOEKT_INDEX_DIR: "/zoekt-index",
}))

const { executeScipGraphQueryMock, getAccessibleRepositoryMock } = vi.hoisted(
  () => ({
    executeScipGraphQueryMock: vi.fn(),
    getAccessibleRepositoryMock: vi.fn(),
  }),
)

vi.mock("../domain/graph/executeGraphPrimitive.js", () => ({
  executeScipGraphQuery: executeScipGraphQueryMock,
}))

vi.mock("../domain/repositories/service.js", () => ({
  getAccessibleRepository: getAccessibleRepositoryMock,
}))

import { registerGraphRoutes } from "./graph.js"

function createTestApp(workspaceId: string) {
  const limit = vi.fn().mockResolvedValue([{ id: "checkout_1" }])
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("db", {
      select,
      transaction: async (
        fn: (tx: {
          select: typeof select
          execute: () => Promise<void>
        }) => unknown,
      ) => fn({ select, execute: async () => undefined }),
    } as unknown as AppEnv["Variables"]["db"])
    c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
    c.set("auth", {
      sub: "user_test",
      orgId: "org_mock123",
      principal: "user",
      workspaceId,
    })
    await next()
  })
  registerGraphRoutes(app)
  return app
}

describe("POST /{repoId}/graph checkout isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAccessibleRepositoryMock.mockResolvedValue({
      id: "repo_abcdef27",
      orgId: "org_mock123",
      gitUrl: "https://github.com/ctxpipe/repo.git",
    })
    executeScipGraphQueryMock.mockResolvedValue({
      ok: true,
      results: [],
    })
  })

  it("rejects a checkoutKey that differs from the JWT workspace", async () => {
    const res = await createTestApp("ws_alpha").request(
      "/repo_abcdef27/graph",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          primitive: "find_symbol",
          symbol: "needle",
          checkoutKey: "ws:ws_beta",
        }),
      },
    )

    expect(res.status).toBe(403)
    expect(executeScipGraphQueryMock).not.toHaveBeenCalled()
  })

  it("uses the JWT workspace checkout when the request omits checkoutKey", async () => {
    const res = await createTestApp("ws_alpha").request(
      "/repo_abcdef27/graph",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          primitive: "find_symbol",
          symbol: "needle",
        }),
      },
    )

    expect(res.status).toBe(200)
    expect(executeScipGraphQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/repo-cache/org_mock123/repo_abcdef27/checkouts/ws:ws_alpha",
        scipIndexPath:
          "/repo-cache/org_mock123/repo_abcdef27/checkouts/ws:ws_alpha.scip",
      }),
    )
  })
})
