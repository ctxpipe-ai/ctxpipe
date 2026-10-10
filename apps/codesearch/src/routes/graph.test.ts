import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

// config/paths.js reads this variable when it loads.
const { cacheRoot } = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "graph-route-")))
  vi.stubEnv("REPO_CACHE_DIR", root)
  return { cacheRoot: root }
})

const { getAccessibleRepositoryMock } = vi.hoisted(() => ({
  getAccessibleRepositoryMock: vi.fn(),
}))

// Codesearch tests have no database, so this stubs the repository row lookup.
vi.mock("../domain/repositories/service.js", () => ({
  getAccessibleRepository: getAccessibleRepositoryMock,
}))

import { registerGraphRoutes } from "./graph.js"

function createTestApp(workspaceId?: string) {
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
  const checkoutDir = join(
    cacheRoot,
    "org_mock123",
    "repo_abcdef27",
    "checkouts",
    "default",
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    await mkdir(join(checkoutDir, ".git"), { recursive: true })
    await mkdir(join(checkoutDir, "src"), { recursive: true })
    await writeFile(join(checkoutDir, ".git", "config"), "token\n")
    await writeFile(join(checkoutDir, "src", "a.ts"), "export {}\n")
    getAccessibleRepositoryMock.mockResolvedValue({
      id: "repo_abcdef27",
      orgId: "org_mock123",
      gitUrl: "https://github.com/ctxpipe/repo.git",
    })
  })

  afterAll(async () => {
    await rm(cacheRoot, { recursive: true, force: true })
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
  })

  it.each([
    ".git/config",
    "../outside.ts",
  ])("answers 404 for the file path %s", async (filePath) => {
    const res = await createTestApp().request("/repo_abcdef27/graph", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ primitive: "get_imports", filePath }),
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Path not found" })
  })

  it("queries the graph for a file inside the checkout", async () => {
    const res = await createTestApp().request("/repo_abcdef27/graph", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ primitive: "get_imports", filePath: "src/a.ts" }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      primitive: "get_imports",
      results: [],
    })
  })
})
