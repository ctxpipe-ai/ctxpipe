import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import {
  resolveGithubBranchTip,
  resolveGithubDefaultBranch,
  resolveWorkspaceRepositoryTip,
} from "../../routes/webhooks/github/github-workspace-tip.js"
import {
  listMarkdownFilesAtGitSha,
  listPathsAtGitSha,
  readFileAtGitSha,
} from "./clone-tree.js"

const execFileAsync = promisify(execFile)

describe("clone-tree", { timeout: 30_000 }, () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it("reads a native SHA-256 repository at its immutable commit", async () => {
    dir = await mkdtemp(join(tmpdir(), "ctxpipe-sha256-tree-"))
    const git = async (...args: string[]) =>
      (await execFileAsync("git", ["-C", dir as string, ...args])).stdout.trim()
    await git("init", "--object-format=sha256", "-b", "main")
    await writeFile(join(dir, "knowledge.md"), "# SHA-256 knowledge\n")
    await git("add", "knowledge.md")
    await git(
      "-c",
      "user.name=Contract",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "-m",
      "SHA-256 fixture",
    )
    const sha = await git("rev-parse", "HEAD")
    expect(sha).toHaveLength(64)
    expect(await listMarkdownFilesAtGitSha({ url: dir, sha })).toEqual([
      { path: "knowledge.md", content: "# SHA-256 knowledge\n" },
    ])
  })

  it("reads an authenticated Git remote without putting the token in Git arguments or origin", async () => {
    dir = await mkdtemp(join(tmpdir(), "ctxpipe-private-tree-"))
    const git = async (...args: string[]) =>
      (await execFileAsync("git", ["-C", dir as string, ...args])).stdout.trim()
    await git("init", "-b", "main")
    await git("config", "user.name", "Contract")
    await git("config", "user.email", "contract@example.test")
    await writeFile(join(dir, "private.md"), "# Private repository\n")
    await git("add", ".")
    await git("commit", "-m", "Private fixture")
    const sha = await git("rev-parse", "HEAD")
    const remote = join(dir, "remote.git")
    await git("clone", "--bare", dir, remote)
    const token = "fixture-read-only-secret"
    const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
    const tracePath = join(dir, "private-git-trace.jsonl")
    let authenticatedRequests = 0
    let fetchedOrigin: string | undefined
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== authorization) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' })
        res.end()
        return
      }
      authenticatedRequests++
      const url = new URL(req.url ?? "/", "http://fixture")
      try {
        if (fetchedOrigin === undefined) {
          const events = (await readFile(tracePath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
          const init = events.find(
            (event) => event.event === "start" && event.argv?.[1] === "init",
          )
          if (!init) throw new Error("Missing Git init observation")
          fetchedOrigin = (
            await execFileAsync("git", [
              "-C",
              init.argv[2],
              "config",
              "--get",
              "remote.origin.url",
            ])
          ).stdout.trim()
        }
        const execution = execFileAsync("git", ["http-backend"], {
          encoding: "buffer",
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: dir,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: `/remote.git${url.pathname}`,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: req.method,
            CONTENT_TYPE: req.headers["content-type"],
            REMOTE_USER: "contract",
          },
        })
        if (!execution.child.stdin) throw new Error("Git CGI has no stdin")
        req.pipe(execution.child.stdin)
        const { stdout } = await execution
        const boundary = stdout.indexOf("\r\n\r\n")
        if (boundary < 0) throw new Error("Git CGI returned no headers")
        for (const line of stdout
          .subarray(0, boundary)
          .toString()
          .split("\r\n")) {
          const colon = line.indexOf(":")
          const name = line.slice(0, colon)
          const value = line.slice(colon + 1).trim()
          if (name.toLowerCase() === "status")
            res.statusCode = Number(value.split(" ")[0])
          else res.setHeader(name, value)
        }
        res.end(stdout.subarray(boundary + 4))
      } catch {
        res.writeHead(500)
        res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address")
    const previousTrace = process.env.GIT_TRACE2_EVENT
    process.env.GIT_TRACE2_EVENT = tracePath
    try {
      await expect(
        listMarkdownFilesAtGitSha({
          url: `http://127.0.0.1:${address.port}`,
          sha,
          token,
        }),
      ).resolves.toEqual([
        { path: "private.md", content: "# Private repository\n" },
      ])
      expect(authenticatedRequests).toBeGreaterThan(0)
      expect(fetchedOrigin).toBe(`http://127.0.0.1:${address.port}`)
      const trace = await readFile(tracePath, "utf8")
      expect(trace).not.toContain(token)
      expect(trace).not.toContain(authorization)
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previousTrace
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it("uses native Git for GitHub branch and default-branch policy callers", async () => {
    dir = await mkdtemp(join(tmpdir(), "ctxpipe-native-github-policy-"))
    const git = async (...args: string[]) =>
      (await execFileAsync("git", ["-C", dir as string, ...args])).stdout.trim()
    await git("init", "-b", "trunk")
    await git(
      "-c",
      "user.name=Contract",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "Native policy",
    )
    const sha = await git("rev-parse", "HEAD")
    const config = join(dir, "fixture.gitconfig")
    await writeFile(
      config,
      `[url "${dir}"]\n  insteadOf = https://github.com/fixture/native-policy\n`,
    )
    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = config
    try {
      const input = {
        orgId: "org_native_policy",
        repoFullName: "fixture/native-policy",
        env: parseEnv(process.env),
      }
      expect(await resolveGithubDefaultBranch(input)).toBe("trunk")
      expect(await resolveGithubBranchTip({ ...input, branch: "trunk" })).toBe(
        sha,
      )
      await git("branch", "-m", "renamed")
      expect(await resolveGithubDefaultBranch(input)).toBe("renamed")
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous
    }
  })

  it("rejects embedded HTTP credentials before acquiring a repository", async () => {
    await expect(
      listPathsAtGitSha({
        url: "http://fixture-user:fixture-password@127.0.0.1:1/repo.git",
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).rejects.toThrow("Git reads require a credential-free remote")
  })

  it("resolves the native remote default branch, an explicit branch, and a rewind", async () => {
    dir = await mkdtemp(join(tmpdir(), "ctxpipe-native-tip-"))
    const git = async (...args: string[]) =>
      (await execFileAsync("git", ["-C", dir as string, ...args])).stdout.trim()
    await git("init", "-b", "trunk")
    await git("config", "user.name", "Contract")
    await git("config", "user.email", "contract@example.test")
    await git("commit", "--allow-empty", "-m", "First")
    const first = await git("rev-parse", "HEAD")
    await git("branch", "old")
    await git("commit", "--allow-empty", "-m", "Second")
    const second = await git("rev-parse", "HEAD")
    const input = {
      orgId: "org_native_tip_contract",
      workspaceRepositoryUrl: dir,
      env: parseEnv(process.env),
    }
    await expect(resolveWorkspaceRepositoryTip(input)).resolves.toBe(second)
    await expect(
      resolveWorkspaceRepositoryTip({ ...input, branch: "old" }),
    ).resolves.toBe(first)
    await git("reset", "--hard", first)
    await expect(resolveWorkspaceRepositoryTip(input)).resolves.toBe(first)
  })

  it("lists paths and reads a blob at a stored SHA", async () => {
    dir = await mkdtemp(join(tmpdir(), "ctxpipe-clone-tree-"))
    await execFileAsync("git", ["init", dir])
    await execFileAsync("git", [
      "-C",
      dir,
      "config",
      "user.email",
      "dev@example.com",
    ])
    await execFileAsync("git", ["-C", dir, "config", "user.name", "Dev"])
    await writeFile(join(dir, "AGENTS.md"), "# Agents\n")
    await writeFile(join(dir, "notes.txt"), "hello\n")
    await execFileAsync("git", ["-C", dir, "add", "."])
    await execFileAsync("git", ["-C", dir, "commit", "-m", "seed"])
    const { stdout } = await execFileAsync("git", [
      "-C",
      dir,
      "rev-parse",
      "HEAD",
    ])
    const sha = stdout.trim()

    await expect(listPathsAtGitSha({ url: dir, sha })).resolves.toEqual(
      expect.arrayContaining(["AGENTS.md", "notes.txt"]),
    )
    await expect(listMarkdownFilesAtGitSha({ url: dir, sha })).resolves.toEqual(
      [{ path: "AGENTS.md", content: "# Agents\n" }],
    )
    await expect(
      readFileAtGitSha({ url: dir, sha, path: "notes.txt" }),
    ).resolves.toEqual({
      kind: "bytes",
      bytes: Buffer.from("hello\n"),
    })
    await expect(
      readFileAtGitSha({ url: dir, sha: "HEAD", path: "notes.txt" }),
    ).rejects.toThrow("A full immutable Git commit SHA is required")
    await writeFile(
      join(dir, "oversize.bin"),
      Buffer.alloc(11 * 1024 * 1024, 65),
    )
    await execFileAsync("git", ["-C", dir, "add", "oversize.bin"])
    await execFileAsync("git", ["-C", dir, "commit", "-m", "Large blob"])
    const largeSha = (
      await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"])
    ).stdout.trim()
    await expect(
      readFileAtGitSha({ url: dir, sha: largeSha, path: "oversize.bin" }),
    ).rejects.toThrow()
    await expect(
      readFileAtGitSha({ url: dir, sha, path: "missing.md" }),
    ).resolves.toEqual({ kind: "missing" })
    await expect(
      readFileAtGitSha({ url: dir, sha, path: "../secret" }),
    ).resolves.toEqual({ kind: "missing" })
  })

  it("does not follow a repo symlink out of the checkout", async () => {
    dir = await mkdtemp(join(tmpdir(), "ctxpipe-clone-tree-"))
    await execFileAsync("git", ["init", dir])
    await execFileAsync("git", [
      "-C",
      dir,
      "config",
      "user.email",
      "dev@example.com",
    ])
    await execFileAsync("git", ["-C", dir, "config", "user.name", "Dev"])
    await execFileAsync("ln", ["-s", "/etc/passwd", join(dir, "leak")])
    await execFileAsync("git", ["-C", dir, "add", "."])
    await execFileAsync("git", ["-C", dir, "commit", "-m", "symlink"])
    const { stdout } = await execFileAsync("git", [
      "-C",
      dir,
      "rev-parse",
      "HEAD",
    ])
    const sha = stdout.trim()

    const file = await readFileAtGitSha({ url: dir, sha, path: "leak" })
    expect(file).toEqual({
      kind: "bytes",
      bytes: Buffer.from("/etc/passwd"),
    })
    expect(
      file.kind === "bytes" ? Buffer.from(file.bytes).toString("utf8") : "",
    ).not.toMatch(/root:/)
  })

  it("fails clearly when git is not on PATH", async () => {
    const previousPath = process.env.PATH
    process.env.PATH = "/tmp/ctxpipe-no-git"
    try {
      await expect(
        listPathsAtGitSha({
          url: "https://example.com/repo.git",
          sha: "a".repeat(40),
        }),
      ).rejects.toThrow(
        "git is not installed on this service; cannot read a repository by clone.",
      )
    } finally {
      process.env.PATH = previousPath
    }
  })
})
