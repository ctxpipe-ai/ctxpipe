import { execFileSync } from "node:child_process"
import { mkdirSync, renameSync } from "node:fs"
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { AppEnv } from "../app/env.js"
import { startGitHttpServer } from "../test/gitHttpServer.js"

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

/**
 * Makes a directory tree whose deepest path is longer than PATH_MAX. Opening
 * it by its absolute path fails with ENAMETOOLONG, also for root, so the
 * listing fails with an error that is not a missing path.
 */
function makeTooDeepDirectory(path: string) {
  // Each rename uses short paths. The moved tree grows by one level each time.
  const name = "d".repeat(200)
  const next = `${path}.next`
  mkdirSync(path)
  for (let level = 0; level < 25; level++) {
    mkdirSync(next)
    renameSync(path, join(next, name))
    renameSync(next, path)
  }
}

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
  let remoteRoot: string
  let mainHash: string
  let server: Awaited<ReturnType<typeof startGitHttpServer>>

  beforeAll(async () => {
    remoteRoot = await mkdtemp(join(tmpdir(), "resolve-ref-remote-"))
    const remoteDir = join(remoteRoot, "work")
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: remoteDir, encoding: "utf8" }).trim()
    await mkdir(remoteDir)
    git("init", "--quiet", "--initial-branch=trunk")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    await writeFile(join(remoteDir, "README.md"), "# remote\n")
    git("add", "README.md")
    git("commit", "--quiet", "-m", "first")
    git("branch", "main")
    mainHash = git("rev-parse", "main")
    git(
      "clone",
      "--quiet",
      "--bare",
      remoteDir,
      join(remoteRoot, "team", "app.git"),
    )
    server = await startGitHttpServer(remoteRoot)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    getAccessibleRepositoryMock.mockResolvedValue({
      ...MOCK_REPO,
      gitUrl: "http://git.internal/team/app.git",
    })
  })

  afterAll(async () => {
    await server?.stop()
    await rm(remoteRoot, { recursive: true, force: true })
  })

  // The remote that the backend checked.
  const plainGit = () => ({
    url: `http://127.0.0.1:${server.port}/team/app.git`,
    http: true,
  })

  const resolveRef = (body: Record<string, unknown>) =>
    createTestApp().request("/repo_abcdef27/resolve-ref", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("returns the hash of the requested branch", async () => {
    const res = await resolveRef({ branch: "main", plainGit: plainGit() })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ branch: "main", hash: mainHash })
  })

  it("resolves the remote default branch when the body has no branch", async () => {
    const res = await resolveRef({ plainGit: plainGit() })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ branch: "trunk", hash: mainHash })
  })

  it("does not read a stored local path, or a URL with no token and no checked remote", async () => {
    for (const gitUrl of [
      join(remoteRoot, "team", "app.git"),
      `file://${join(remoteRoot, "team", "app.git")}`,
      `http://127.0.0.1:${server.port}/team/app.git`,
    ]) {
      getAccessibleRepositoryMock.mockResolvedValue({ ...MOCK_REPO, gitUrl })
      const before = server.requests.length
      const res = await resolveRef({ branch: "main" })
      expect(res.status, gitUrl).toBe(500)
      expect(await res.json()).toEqual({
        error: expect.stringMatching(
          /only with a GitHub token or with a plain git remote/,
        ),
      })
      expect(server.requests.length).toBe(before)
    }
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
    const res = await resolveRef({
      branch: "main",
      plainGit: {
        ...plainGit(),
        url: `http://127.0.0.1:${server.port}/team/missing.git`,
      },
    })

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
    await mkdir(checkoutDir, { recursive: true })
    makeTooDeepDirectory(join(checkoutDir, "deep"))
    loggedErrors.length = 0
    try {
      const res = await createTreeTestApp().request("/repo_abcdef27/tree")

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: "Tree listing failed" })
      expect(loggedErrors.join("\n")).toContain("deep")
    } finally {
      execFileSync("rm", ["-rf", join(checkoutDir, "deep")])
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
    await mkdir(checkoutDir, { recursive: true })
    makeTooDeepDirectory(join(checkoutDir, "deep"))
    loggedErrors.length = 0
    try {
      const res = await createTestApp().request("/repo_abcdef27/glob", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: "**/*" }),
      })

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: "Glob scan failed" })
      expect(loggedErrors.join("\n")).toContain("deep")
    } finally {
      execFileSync("rm", ["-rf", join(checkoutDir, "deep")])
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

  it("POST /files-query with a root reads only below the root folder", async () => {
    // The link stays in the checkout but leaves the root folder.
    await symlink("../inside.txt", join(checkoutDir, "sub", "up-link"))
    await symlink("inner.txt", join(checkoutDir, "sub", "side-link"))
    await mkdir(join(checkoutDir, "sub", "deep"))
    await writeFile(join(checkoutDir, "sub", "deep", "x.txt"), "deep\n")
    const app = createTestApp()
    const query = async (root: string, paths: string[]) => {
      const res = await app.request("/repo_abcdef27/files-query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root, paths }),
      })
      return { status: res.status, body: (await res.json()) as object }
    }

    const sub = await query("sub", [
      "inner.txt",
      "side-link",
      "up-link",
      "../inside.txt",
    ])
    expect(sub.status).toBe(200)
    expect(Object.keys(sub.body).sort()).toEqual(["inner.txt", "side-link"])
    expect((await query("sub/deep", ["x.txt"])).body).toHaveProperty("x.txt")
    // A root folder with a symlink at any segment holds no files, also when
    // the link stays in the checkout.
    for (const root of [
      "in-dir",
      "in-dir/deep",
      "out-dir",
      "git-dir",
      "missing",
    ])
      expect(await query(root, ["inner.txt", "config"])).toEqual({
        status: 200,
        body: {},
      })
    for (const root of ["../outside", "/etc", "sub/../.."])
      expect((await query(root, ["inner.txt"])).status).toBe(400)
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
