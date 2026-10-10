import { execFileSync } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { AppEnv } from "../app/env.js"

// config/paths.js reads these variables when it loads.
const { cacheRoot } = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-route-")))
  vi.stubEnv("REPO_CACHE_DIR", join(root, "repo-cache"))
  vi.stubEnv("ZOEKT_INDEX_DIR", join(root, "zoekt-index"))
  return { cacheRoot: root }
})

const { getAccessibleRepositoryMock } = vi.hoisted(() => ({
  getAccessibleRepositoryMock: vi.fn(),
}))

// Codesearch tests have no database, so this stubs the repository row lookup.
vi.mock("../domain/repositories/service.js", () => ({
  getAccessibleRepository: getAccessibleRepositoryMock,
  getIndexableRepository: vi.fn(),
}))

import { registerRepoRoutes } from "./repo.js"

const repoCacheDir = join(cacheRoot, "repo-cache")
const loggedErrors: string[] = []

afterEach(async () => {
  await rm(repoCacheDir, { recursive: true, force: true })
})

afterAll(async () => {
  await rm(cacheRoot, { recursive: true, force: true })
})

const MOCK_REPO = {
  id: "repo_abcdef27",
  orgId: "org_mock123",
  gitUrl: "https://github.com/appear/ctxpipe.git",
}

function createTreeTestApp() {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
    c.set("log", {
      error: (error: Error | string) => loggedErrors.push(String(error)),
    } as unknown as AppEnv["Variables"]["log"])
    c.set("auth", {
      sub: "repo:repo_abcdef27",
      orgId: "org_mock123",
      principal: "service",
      repositoryRevisions: [
        { repositoryId: "repo_abcdef27", sha: "a".repeat(40) },
      ],
    } as AppEnv["Variables"]["auth"])
    await next()
  })
  registerRepoRoutes(app)
  return app
}

function createTestApp() {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("db", {} as AppEnv["Variables"]["db"])
    c.set("env", { NODE_ENV: "test", PORT: 3001 } as AppEnv["Variables"]["env"])
    c.set("log", {
      error: (error: Error | string) => loggedErrors.push(String(error)),
    } as unknown as AppEnv["Variables"]["log"])
    c.set("auth", {
      sub: "user_test",
      orgId: "org_mock123",
      principal: "user",
    } as AppEnv["Variables"]["auth"])
    await next()
  })
  registerRepoRoutes(app)
  return app
}

describe("GET /{repoId}/files", () => {
  let tmpDir: string
  let checkoutDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    getAccessibleRepositoryMock.mockResolvedValue(MOCK_REPO)
    tmpDir = await mkdtemp(join(tmpdir(), "list-files-test-"))
    checkoutDir = join(
      repoCacheDir,
      "org_mock123",
      "repo_abcdef27",
      "checkouts",
      "default",
    )
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
  let checkoutDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    getAccessibleRepositoryMock.mockResolvedValue(MOCK_REPO)
    tmpDir = await mkdtemp(join(tmpdir(), "get-file-test-"))
    checkoutDir = join(
      repoCacheDir,
      "org_mock123",
      "repo_abcdef27",
      "checkouts",
      "default",
    )
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
    await writeFile(
      join(websiteDir, "themes", "doks", "config.toml"),
      "title = 'test'\n",
    )
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
  let remoteDir: string
  let mainHash: string

  beforeEach(async () => {
    vi.clearAllMocks()
    remoteDir = await mkdtemp(join(tmpdir(), "resolve-ref-remote-"))
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: remoteDir, encoding: "utf8" }).trim()
    git("init", "--quiet", "--initial-branch=trunk")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    await writeFile(join(remoteDir, "README.md"), "# remote\n")
    git("add", "README.md")
    git("commit", "--quiet", "-m", "first")
    git("branch", "main")
    mainHash = git("rev-parse", "main")
    getAccessibleRepositoryMock.mockResolvedValue({
      ...MOCK_REPO,
      gitUrl: remoteDir,
    })
  })

  afterEach(async () => {
    await rm(remoteDir, { recursive: true, force: true })
  })

  const resolveRef = (body: Record<string, string>) =>
    createTestApp().request("/repo_abcdef27/resolve-ref", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("returns the hash of the requested branch", async () => {
    const res = await resolveRef({ branch: "main" })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ branch: "main", hash: mainHash })
  })

  it("resolves the remote default branch when the body has no branch", async () => {
    const res = await resolveRef({})

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ branch: "trunk", hash: mainHash })
  })

  it("accepts a githubToken in the request body", async () => {
    const res = await resolveRef({
      branch: "main",
      githubToken: "ghs_testtoken123",
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ branch: "main", hash: mainHash })
  })

  it("returns 404 when repository is not accessible", async () => {
    getAccessibleRepositoryMock.mockResolvedValue(null)

    const res = await resolveRef({})

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({
      error: "Repository not found or access denied",
      code: "repository_not_found",
    })
  })

  it("returns 500 when ref resolution fails", async () => {
    getAccessibleRepositoryMock.mockResolvedValue({
      ...MOCK_REPO,
      gitUrl: join(remoteDir, "missing"),
    })

    const res = await resolveRef({ branch: "main" })

    expect(res.status).toBe(500)
  })
})

describe("GET /{repoId}/tree", () => {
  let tmpDir: string
  let checkoutDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    tmpDir = await mkdtemp(join(tmpdir(), "list-tree-route-"))
    checkoutDir = join(
      repoCacheDir,
      "org_mock123",
      "repo_abcdef27",
      "checkouts",
      `rev:${"a".repeat(40)}`,
    )
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("lists captured revision files without querying Postgres", async () => {
    await mkdir(join(checkoutDir, ".git", "objects"), { recursive: true })
    await mkdir(join(checkoutDir, "src"), { recursive: true })
    await writeFile(join(checkoutDir, "README.md"), "# root\n")
    await writeFile(join(checkoutDir, "src", "a.ts"), "export {}\n")
    await writeFile(join(checkoutDir, ".git", "objects", "pack.idx"), "idx\n")

    const app = createTreeTestApp()
    const res = await app.request("/repo_abcdef27/tree")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { paths: string[] }
    expect(body.paths.sort()).toEqual(["README.md", "src/a.ts"])
    expect(getAccessibleRepositoryMock).not.toHaveBeenCalled()
  })

  it("returns a fixed message for a failed listing and logs the detail", async () => {
    await mkdir(join(checkoutDir, "locked"), { recursive: true })
    await chmod(join(checkoutDir, "locked"), 0o000)
    loggedErrors.length = 0
    try {
      const res = await createTreeTestApp().request("/repo_abcdef27/tree")

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: "Tree listing failed" })
      expect(loggedErrors.join("\n")).toContain("locked")
    } finally {
      await chmod(join(checkoutDir, "locked"), 0o755)
    }
  })

  it("returns 404 immediately when the checkout is missing", async () => {
    const app = createTreeTestApp()
    const started = performance.now()
    const res = await app.request("/repo_abcdef27/tree")
    expect(res.status).toBe(404)
    expect(performance.now() - started).toBeLessThan(200)
    expect(getAccessibleRepositoryMock).not.toHaveBeenCalled()
  })
})

const hasBunGlob = Boolean(
  (globalThis as { Bun?: { Glob?: unknown } }).Bun?.Glob,
)

describe("POST /{repoId}/glob", () => {
  let tmpDir: string
  let checkoutDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    getAccessibleRepositoryMock.mockResolvedValue(MOCK_REPO)
    tmpDir = await mkdtemp(join(tmpdir(), "glob-route-test-"))
    checkoutDir = join(
      repoCacheDir,
      "org_mock123",
      "repo_abcdef27",
      "checkouts",
      "default",
    )
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("returns a fixed message for a failed scan and logs the detail", async () => {
    await mkdir(join(checkoutDir, "locked"), { recursive: true })
    await chmod(join(checkoutDir, "locked"), 0o000)
    loggedErrors.length = 0
    try {
      const res = await createTestApp().request("/repo_abcdef27/glob", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: "**/*" }),
      })

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: "Glob scan failed" })
      expect(loggedErrors.join("\n")).toContain("locked")
    } finally {
      await chmod(join(checkoutDir, "locked"), 0o755)
    }
  })

  // This route suite runs under Bun so the production Glob implementation executes.
  it("returns files and dirs for pattern * by default", async () => {
    await mkdir(join(checkoutDir, "src", "nested"), { recursive: true })
    await writeFile(join(checkoutDir, "src", "a.ts"), "export {}\n")

    const app = createTestApp()
    const res = await app.request("/repo_abcdef27/glob", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern: "*", path: "src" }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      entries: Array<{ name: string; path: string; type: string }>
      truncated: boolean
      matched: number
    }
    const names = body.entries.map((e) => e.name).sort()
    expect(names).toContain("a.ts")
    expect(names).toContain("nested")
    expect(body.truncated).toBe(false)
    expect(body.matched).toBe(body.entries.length)
  })

  it.skipIf(!hasBunGlob)("matches dotpaths with default dot true", async () => {
    await mkdir(join(checkoutDir, ".cursor", "rules"), { recursive: true })
    await writeFile(join(checkoutDir, ".cursor", "rules", "x.mdc"), "rule\n")

    const app = createTestApp()
    const res = await app.request("/repo_abcdef27/glob", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pattern: "**/*.{md,mdc}",
        onlyFiles: true,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      entries: Array<{ path: string }>
    }
    expect(body.entries.map((e) => e.path)).toContain(".cursor/rules/x.mdc")
  })

  it("returns 404 for missing path", async () => {
    await mkdir(checkoutDir, { recursive: true })

    const app = createTestApp()
    const res = await app.request("/repo_abcdef27/glob", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern: "*", path: "missing" }),
    })

    expect(res.status).toBe(404)
  })

  it("returns 400 for path traversal via cwd", async () => {
    await mkdir(checkoutDir, { recursive: true })

    const app = createTestApp()
    const res = await app.request("/repo_abcdef27/glob", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern: "*", path: "../outside" }),
    })

    expect(res.status).toBe(400)
  })

  it("returns 400 for path traversal via pattern", async () => {
    await mkdir(checkoutDir, { recursive: true })

    const app = createTestApp()
    const res = await app.request("/repo_abcdef27/glob", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern: "../**", path: "src" }),
    })

    expect(res.status).toBe(400)
  })
})

describe("POST /{repoId}/purge", () => {
  const repoRoot = join(repoCacheDir, "org_mock123", "repo_abcdef27")

  beforeEach(async () => {
    vi.clearAllMocks()
    await mkdir(join(repoRoot, "checkouts", "default"), { recursive: true })
    await writeFile(join(repoRoot, "checkouts", "default", "a.ts"), "a\n")
  })

  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    )

  function createServiceApp(sub: string) {
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("db", {} as AppEnv["Variables"]["db"])
      c.set("env", {
        NODE_ENV: "test",
        PORT: 3001,
      } as AppEnv["Variables"]["env"])
      c.set("auth", {
        sub,
        orgId: "org_mock123",
        principal: "service",
      } as AppEnv["Variables"]["auth"])
      await next()
    })
    registerRepoRoutes(app)
    return app
  }

  const purge = (app: OpenAPIHono<AppEnv>, body: Record<string, unknown>) =>
    app.request("/repo_abcdef27/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("purges from the accessible repository row when present", async () => {
    getAccessibleRepositoryMock.mockResolvedValue({
      ...MOCK_REPO,
      name: "ctxpipe",
    })

    const res = await purge(createTestApp(), { zoektRepoId: 7 })

    expect(res.status).toBe(200)
    expect(await exists(repoRoot)).toBe(false)
  })

  it("allows service principal purge when the row is already gone", async () => {
    getAccessibleRepositoryMock.mockResolvedValue(null)

    const res = await purge(createServiceApp("repo-purge:repo_abcdef27"), {
      zoektRepoId: 7,
      repoName: "ctxpipe",
    })

    expect(res.status).toBe(200)
    expect(await exists(repoRoot)).toBe(false)
  })

  it("rejects user principal purge when the row is gone even with repoName", async () => {
    getAccessibleRepositoryMock.mockResolvedValue(null)

    const res = await purge(createTestApp(), {
      zoektRepoId: 7,
      repoName: "ctxpipe",
    })

    expect(res.status).toBe(404)
    expect(await exists(repoRoot)).toBe(true)
  })

  it("rejects service principal when JWT sub does not match path repoId", async () => {
    getAccessibleRepositoryMock.mockResolvedValue(null)

    const res = await purge(createServiceApp("repo-purge:repo_other"), {
      zoektRepoId: 7,
      repoName: "ctxpipe",
    })

    expect(res.status).toBe(404)
    expect(await exists(repoRoot)).toBe(true)
  })
})

describe("reads stay inside the checkout", () => {
  let tmpDir: string
  let checkoutDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    getAccessibleRepositoryMock.mockResolvedValue(MOCK_REPO)
    tmpDir = await mkdtemp(join(tmpdir(), "contained-read-test-"))
    checkoutDir = join(
      repoCacheDir,
      "org_mock123",
      "repo_abcdef27",
      "checkouts",
      "default",
    )
    const outside = join(tmpDir, "outside")
    await mkdir(join(outside, "dir"), { recursive: true })
    await writeFile(join(outside, "data.txt"), "outside\n")
    await writeFile(join(outside, "dir", "inner.txt"), "outside\n")
    await mkdir(join(checkoutDir, "sub"), { recursive: true })
    await writeFile(join(checkoutDir, "inside.txt"), "inside\n")
    await writeFile(join(checkoutDir, "sub", "inner.txt"), "inside\n")
    await symlink(join(outside, "data.txt"), join(checkoutDir, "abs-link"))
    await symlink(
      relative(join(checkoutDir, "sub"), join(outside, "data.txt")),
      join(checkoutDir, "sub", "rel-link"),
    )
    await symlink(join(outside, "dir"), join(checkoutDir, "out-dir"))
    await symlink("chain-b", join(checkoutDir, "chain-a"))
    await symlink(join(outside, "data.txt"), join(checkoutDir, "chain-b"))
    await symlink("inside.txt", join(checkoutDir, "in-link"))
    await symlink("sub", join(checkoutDir, "in-dir"))
    await symlink("missing.txt", join(checkoutDir, "dangling"))
    await mkdir(join(checkoutDir, ".git"))
    await writeFile(join(checkoutDir, ".git", "config"), "token\n")
    await symlink(".git", join(checkoutDir, "git-dir"))
    await symlink(".git/config", join(checkoutDir, "config-link"))
    await mkdir(join(checkoutDir, "nested", ".git"), { recursive: true })
    await writeFile(join(checkoutDir, "nested", ".git", "config"), "nested\n")
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  const refusedFiles = [
    "abs-link",
    "sub/rel-link",
    "out-dir/inner.txt",
    "chain-a",
    "dangling",
    ".git/config",
    ".GIT/config",
    "nested/.git/config",
    "config-link",
    "git-dir/config",
  ]

  it.each(
    refusedFiles,
  )("GET /files/{path} answers %s like a missing file", async (path) => {
    const app = createTestApp()
    const missing = await app.request("/repo_abcdef27/files/missing.txt")
    const res = await app.request(
      `/repo_abcdef27/files/${encodeURIComponent(path)}`,
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(await missing.json())
  })

  it("POST /files-query omits refused files and keeps files inside", async () => {
    const app = createTestApp()
    const res = await app.request("/repo_abcdef27/files-query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paths: [...refusedFiles, "inside.txt", "in-link", "in-dir/inner.txt"],
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    expect(Object.keys(body).sort()).toEqual([
      "in-dir/inner.txt",
      "in-link",
      "inside.txt",
    ])
    expect(atob(body["in-link"] as string)).toBe("inside\n")
  })

  it("GET /files answers a symlinked directory outside like a missing one", async () => {
    const app = createTestApp()
    const missing = await app.request("/repo_abcdef27/files?path=missing")
    const res = await app.request("/repo_abcdef27/files?path=out-dir")

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(await missing.json())
  })

  it("GET /files lists a symlinked directory inside", async () => {
    const app = createTestApp()
    const res = await app.request("/repo_abcdef27/files?path=in-dir")

    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<{ path: string }> }
    expect(body.entries.map((e) => e.path)).toEqual(["in-dir/inner.txt"])
  })

  it("GET /files leaves a .git child out of the list", async () => {
    const app = createTestApp()
    const root = await app.request("/repo_abcdef27/files")
    const nested = await app.request("/repo_abcdef27/files?path=nested")

    expect(root.status).toBe(200)
    expect(nested.status).toBe(200)
    const rootBody = (await root.json()) as { entries: Array<{ name: string }> }
    const nestedBody = (await nested.json()) as {
      entries: Array<{ name: string }>
    }
    expect(rootBody.entries.map((e) => e.name)).toContain("inside.txt")
    expect(rootBody.entries.map((e) => e.name)).not.toContain(".git")
    expect(nestedBody.entries).toEqual([])
  })

  // .git/config can hold a clone token, so .git is never listed.
  it.each([
    ".git",
    ".GIT",
    "nested/.git",
    "git-dir",
  ])("GET /files and POST /glob answer %s like a missing directory", async (path) => {
    const app = createTestApp()
    const list = await app.request(
      `/repo_abcdef27/files?path=${encodeURIComponent(path)}`,
    )
    const glob = await app.request("/repo_abcdef27/glob", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern: "*", path }),
    })

    expect(list.status).toBe(404)
    expect(glob.status).toBe(404)
  })

  it("POST /glob answers a symlinked directory outside like a missing one", async () => {
    const app = createTestApp()
    const glob = (path: string) =>
      app.request("/repo_abcdef27/glob", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: "*", path }),
      })
    const missing = await glob("missing")
    const res = await glob("out-dir")
    const nested = await glob("out-dir/nested")

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(await missing.json())
    expect(nested.status).toBe(404)
  })
})
