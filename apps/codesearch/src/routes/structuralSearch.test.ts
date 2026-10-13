import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

vi.mock("../config/paths.js", () => ({
  REPO_CACHE_DIR: "",
  ZOEKT_INDEX_DIR: "",
}))

const { getAccessibleRepositoryMock, runStructuralSearchMock } = vi.hoisted(
  () => ({
    getAccessibleRepositoryMock: vi.fn(),
    runStructuralSearchMock: vi.fn(),
  }),
)

vi.mock("../domain/repositories/service.js", () => ({
  getAccessibleRepository: getAccessibleRepositoryMock,
}))

// runStructuralSearch spawns ast-grep with Bun.spawn, which Node vitest lacks.
vi.mock("../domain/search/structuralSearch.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../domain/search/structuralSearch.js")
  >()),
  runStructuralSearch: runStructuralSearchMock,
}))

import * as paths from "../config/paths.js"
import { registerStructuralSearchRoutes } from "./structuralSearch.js"

function createTestApp() {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("db", {} as AppEnv["Variables"]["db"])
    c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
    c.set("auth", {
      sub: "user_test",
      orgId: "org_mock123",
      principal: "user",
    } as AppEnv["Variables"]["auth"])
    await next()
  })
  registerStructuralSearchRoutes(app)
  return app
}

describe("POST /{repoId}/structural-search", () => {
  let tmpDir: string
  let checkoutDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    getAccessibleRepositoryMock.mockResolvedValue({
      id: "repo_abcdef27",
      orgId: "org_mock123",
    })
    tmpDir = await realpath(
      await mkdtemp(join(tmpdir(), "structural-search-route-")),
    )
    checkoutDir = join(
      tmpDir,
      "org_mock123",
      "repo_abcdef27",
      "checkouts",
      "default",
    )
    Object.defineProperty(paths, "REPO_CACHE_DIR", {
      value: tmpDir,
      writable: true,
    })
    await mkdir(join(checkoutDir, "src"), { recursive: true })
    await mkdir(join(checkoutDir, "packages", "api"), { recursive: true })
    await mkdir(join(tmpDir, "outside"))
    await symlink(join(tmpDir, "outside"), join(checkoutDir, "escape"))
    runStructuralSearchMock.mockResolvedValue([{ text: "foo()" }])
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("resolves path arguments inside the checkout and runs ast-grep", async () => {
    const res = await createTestApp().request(
      "/repo_abcdef27/structural-search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pattern: "$F($A)",
          lang: "typescript",
          paths: ["src", "packages/api"],
          globs: ["**/*.ts"],
          limit: 25,
        }),
      },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ matches: [{ text: "foo()" }] })
    expect(runStructuralSearchMock).toHaveBeenCalledWith({
      checkoutPath: checkoutDir,
      pattern: "$F($A)",
      lang: "typescript",
      globs: ["**/*.ts"],
      paths: [join(checkoutDir, "src"), join(checkoutDir, "packages", "api")],
      limit: 25,
    })
  })

  it("rejects path traversal without spawning ast-grep", async () => {
    const res = await createTestApp().request(
      "/repo_abcdef27/structural-search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pattern: "$F($A)",
          paths: ["../outside"],
        }),
      },
    )

    expect(res.status).toBe(400)
    expect(runStructuralSearchMock).not.toHaveBeenCalled()
  })

  it("rejects a symlink escape without spawning ast-grep", async () => {
    const res = await createTestApp().request(
      "/repo_abcdef27/structural-search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pattern: "$F($A)",
          paths: ["escape"],
        }),
      },
    )

    expect(res.status).toBe(400)
    expect(runStructuralSearchMock).not.toHaveBeenCalled()
  })

  it("publishes the route in the generated OpenAPI document", () => {
    const document = createTestApp().getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "test", version: "1" },
    })

    expect(document.paths?.["/{repoId}/structural-search"]?.post).toBeDefined()
  })
})
