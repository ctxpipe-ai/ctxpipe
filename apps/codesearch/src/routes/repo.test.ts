import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

vi.mock("../config/paths.js", () => ({
  REPO_CACHE_DIR: "",
  ZOEKT_INDEX_DIR: "",
}))

const { getAccessibleRepositoryMock, resolveRepositoryRefMock } = vi.hoisted(
  () => ({
    getAccessibleRepositoryMock: vi.fn(),
    resolveRepositoryRefMock: vi.fn(),
  }),
)

vi.mock("../domain/repositories/service.js", () => ({
  getAccessibleRepository: getAccessibleRepositoryMock,
  getIndexableRepository: vi.fn(),
}))

vi.mock("../domain/repositories/resolveRef.js", () => ({
  resolveRepositoryRef: resolveRepositoryRefMock,
}))

import * as paths from "../config/paths.js"
import { registerRepoRoutes } from "./repo.js"

const MOCK_REPO = {
  id: "repo_abcdef27",
  orgId: "org_mock123",
  gitUrl: "https://github.com/appear/ctxpipe.git",
}

function createTestApp() {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("db", {} as AppEnv["Variables"]["db"])
    c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
    c.set(
      "auth",
      {
        sub: "user_test",
        orgId: "org_mock123",
        principal: "user",
      } as AppEnv["Variables"]["auth"],
    )
    await next()
  })
  registerRepoRoutes(app)
  return app
}

describe("GET /{repoId}/files", () => {
  let tmpDir: string
  let repoCacheDir: string
  let checkoutDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    getAccessibleRepositoryMock.mockResolvedValue(MOCK_REPO)
    tmpDir = await mkdtemp(join(tmpdir(), "list-files-test-"))
    repoCacheDir = join(tmpDir, "repo-cache")
    checkoutDir = join(
      repoCacheDir,
      "org_mock123",
      "repo_abcdef27",
      "checkouts",
      "default",
    )
    Object.defineProperty(paths, "REPO_CACHE_DIR", {
      value: repoCacheDir,
      writable: true,
    })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("omits broken symlinks and lists real entries", async () => {
    const websiteDir = join(checkoutDir, "operator", "website")
    await mkdir(join(websiteDir, "themes", "doks"), { recursive: true })
    await writeFile(join(websiteDir, "config.toml"), "title = 'test'\n")
    await symlink(
      "./themes/doks/node_modules",
      join(websiteDir, "node_modules"),
    )

    const app = createTestApp()
    const res = await app.request(
      "/repo_abcdef27/files?path=operator%2Fwebsite",
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      entries: Array<{ name: string; path: string; type: string }>
    }
    const names = body.entries.map((e) => e.name).sort()
    expect(names).toContain("config.toml")
    expect(names).toContain("themes")
    expect(names).not.toContain("node_modules")
  })

  it("returns 404 when directory path does not exist", async () => {
    await mkdir(checkoutDir, { recursive: true })

    const app = createTestApp()
    const res = await app.request("/repo_abcdef27/files?path=missing%2Fdir")

    expect(res.status).toBe(404)
  })
})

describe("GET /{repoId}/files/{path}", () => {
  let tmpDir: string
  let repoCacheDir: string
  let checkoutDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    getAccessibleRepositoryMock.mockResolvedValue(MOCK_REPO)
    tmpDir = await mkdtemp(join(tmpdir(), "get-file-test-"))
    repoCacheDir = join(tmpDir, "repo-cache")
    checkoutDir = join(
      repoCacheDir,
      "org_mock123",
      "repo_abcdef27",
      "checkouts",
      "default",
    )
    Object.defineProperty(paths, "REPO_CACHE_DIR", {
      value: repoCacheDir,
      writable: true,
    })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("reads a regular file", async () => {
    await mkdir(checkoutDir, { recursive: true })
    await writeFile(join(checkoutDir, "hello.txt"), "hello\n")

    const app = createTestApp()
    const res = await app.request("/repo_abcdef27/files/hello.txt")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("hello\n")
  })

  it("follows symlinks to read file content", async () => {
    const websiteDir = join(checkoutDir, "operator", "website")
    await mkdir(join(websiteDir, "themes", "doks"), { recursive: true })
    await writeFile(join(websiteDir, "themes", "doks", "config.toml"), "title = 'test'\n")
    await symlink("./themes/doks/config.toml", join(websiteDir, "linked.toml"))

    const app = createTestApp()
    const res = await app.request(
      "/repo_abcdef27/files/operator%2Fwebsite%2Flinked.toml",
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("title = 'test'\n")
  })

  it("follows symlink directories in the requested path", async () => {
    const websiteDir = join(checkoutDir, "operator", "website")
    await mkdir(join(websiteDir, "themes", "doks"), { recursive: true })
    await writeFile(join(websiteDir, "themes", "doks", "readme.md"), "# docs\n")
    await symlink("./themes/doks", join(websiteDir, "docs"))

    const app = createTestApp()
    const res = await app.request(
      "/repo_abcdef27/files/operator%2Fwebsite%2Fdocs%2Freadme.md",
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("# docs\n")
  })

  it("returns 404 for symlinks that escape the checkout", async () => {
    await mkdir(checkoutDir, { recursive: true })
    const outsideFile = join(tmpDir, "outside-secret.txt")
    await writeFile(outsideFile, "secret\n")
    await symlink(outsideFile, join(checkoutDir, "escape-link.txt"))

    const app = createTestApp()
    const res = await app.request("/repo_abcdef27/files/escape-link.txt")

    expect(res.status).toBe(404)
  })

  it("returns 404 for broken symlinks", async () => {
    await mkdir(checkoutDir, { recursive: true })
    await symlink("./missing-target.txt", join(checkoutDir, "broken-link.txt"))

    const app = createTestApp()
    const res = await app.request("/repo_abcdef27/files/broken-link.txt")

    expect(res.status).toBe(404)
  })
})

describe("POST /{repoId}/resolve-ref", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns resolved branch/hash", async () => {
    getAccessibleRepositoryMock.mockResolvedValue({
      id: "repo_abcdef27",
      orgId: "org_mock123",
      gitUrl: "https://github.com/appear/ctxpipe.git",
    })
    resolveRepositoryRefMock.mockResolvedValue({
      branch: "main",
      hash: "abc123",
    })

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("db", {} as AppEnv["Variables"]["db"])
      c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
      c.set(
        "auth",
        { sub: "user_test", orgId: "org_mock123", principal: "user" } as AppEnv["Variables"]["auth"],
      )
      await next()
    })
    registerRepoRoutes(app)

    const res = await app.request("/repo_abcdef27/resolve-ref", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main" }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ branch: "main", hash: "abc123" })
    expect(resolveRepositoryRefMock).toHaveBeenCalledWith({
      gitUrl: "https://github.com/appear/ctxpipe.git",
      branch: "main",
      githubToken: undefined,
    })
  })

  it("passes githubToken from request body to resolveRepositoryRef", async () => {
    getAccessibleRepositoryMock.mockResolvedValue({
      id: "repo_abcdef27",
      orgId: "org_mock123",
      gitUrl: "https://github.com/appear/ctxpipe.git",
    })
    resolveRepositoryRefMock.mockResolvedValue({
      branch: "main",
      hash: "abc123",
    })

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("db", {} as AppEnv["Variables"]["db"])
      c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
      c.set(
        "auth",
        { sub: "user_test", orgId: "org_mock123", principal: "user" } as AppEnv["Variables"]["auth"],
      )
      await next()
    })
    registerRepoRoutes(app)

    const res = await app.request("/repo_abcdef27/resolve-ref", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main", githubToken: "ghs_testtoken123" }),
    })

    expect(res.status).toBe(200)
    expect(resolveRepositoryRefMock).toHaveBeenCalledWith({
      gitUrl: "https://github.com/appear/ctxpipe.git",
      branch: "main",
      githubToken: "ghs_testtoken123",
    })
  })

  it("returns 404 when repository is not accessible", async () => {
    getAccessibleRepositoryMock.mockResolvedValue(null)

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("db", {} as AppEnv["Variables"]["db"])
      c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
      c.set(
        "auth",
        { sub: "user_test", orgId: "org_mock123", principal: "user" } as AppEnv["Variables"]["auth"],
      )
      await next()
    })
    registerRepoRoutes(app)

    const res = await app.request("/repo_abcdef27/resolve-ref", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(404)
  })

  it("returns 500 when ref resolution fails", async () => {
    getAccessibleRepositoryMock.mockResolvedValue({
      id: "repo_abcdef27",
      orgId: "org_mock123",
      gitUrl: "https://github.com/appear/ctxpipe.git",
    })
    resolveRepositoryRefMock.mockRejectedValue(new Error("failed"))

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("db", {} as AppEnv["Variables"]["db"])
      c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
      c.set(
        "auth",
        { sub: "user_test", orgId: "org_mock123", principal: "user" } as AppEnv["Variables"]["auth"],
      )
      await next()
    })
    registerRepoRoutes(app)

    const res = await app.request("/repo_abcdef27/resolve-ref", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main" }),
    })

    expect(res.status).toBe(500)
  })
})
