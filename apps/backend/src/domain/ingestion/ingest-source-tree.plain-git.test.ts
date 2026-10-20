import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { parseEnv } from "../../config/env.js"
import { usePlainGitNetwork } from "../../services/git/plain-git-remote.js"
import { startGitHttpServer } from "../../test/git-http-server.js"
import {
  ingestSourceTree,
  releaseIngestSourceTree,
} from "./ingest-source-tree.js"
import { MAX_SOURCE_READ_BYTES } from "./patch-validator.js"

/*
 * The host copy of a plain git source (CTX-815), with real git and a real
 * local Git HTTP server at an IP host (self-host).
 */

const RUN_ID = `run_plain_source_tree_${Date.now()}`
const env = parseEnv({
  DATABASE_URL: "postgresql://fixture:fixture@localhost:5432/fixture",
  AUTH_SECRET: "x".repeat(32),
})
let root: string
let sha: string
let largeSha: string
let server: Awaited<ReturnType<typeof startGitHttpServer>>
/** The DNS of the test: no host name has an address. */
const network = { lookup: async () => [] }

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function bare(name: string, files: Record<string, string | Buffer>): string {
  const work = join(root, `${name}-work`)
  mkdirSync(work, { recursive: true })
  for (const [path, text] of Object.entries(files))
    writeFileSync(join(work, path), text)
  git(work, ["init", "--quiet", "-b", "main"])
  git(work, ["add", "."])
  git(work, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ])
  const repo = join(root, "repos", "team", `${name}.git`)
  git(root, ["clone", "--quiet", "--bare", work, repo])
  git(repo, ["config", "uploadpack.allowFilter", "true"])
  git(repo, ["config", "uploadpack.allowAnySHA1InWant", "true"])
  return git(work, ["rev-parse", "HEAD"])
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "plain-source-tree-"))
  sha = bare("app", {
    "README.md": "# Plain app\n",
    "src.ts": "export const plain = 1\n",
    "large.bin": randomBytes(MAX_SOURCE_READ_BYTES + 1024),
  })
  largeSha = bare("pack", { "data.bin": randomBytes(512 * 1024) })
  server = await startGitHttpServer(
    join(root, "repos"),
    (request, response) => {
      // The refs come at once; the pack never comes.
      if (
        request.url?.startsWith("/team/slow.git/") &&
        request.method === "POST"
      ) {
        response.writeHead(200, {
          "content-type": "application/x-git-upload-pack-result",
        })
        response.flushHeaders()
        return true
      }
      if (request.url?.startsWith("/team/slow.git/"))
        request.url = request.url.replace("/team/slow.git/", "/team/app.git/")
      return false
    },
  )
})

beforeEach(() => {
  // Self-host: plain http, a private address, and another port.
  vi.stubEnv("SANDBOX_PROVIDER", "docker")
  usePlainGitNetwork(network)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  usePlainGitNetwork(network)()
  await server?.stop()
  rmSync(root, { recursive: true, force: true })
})

function treeFor(
  holder: string,
  name = "app",
  commit = sha,
  host = "127.0.0.1",
) {
  return ingestSourceTree({
    orgId: "org_fixture",
    runId: RUN_ID,
    source: {
      kind: "git",
      url: `http://${host}:${server.port}/team/${name}.git`,
    },
    sha: commit,
    env,
    holder,
  })
}

describe("ingestSourceTree of a plain git source", () => {
  it("gets each file in the first fetch, so a read never connects to the host", async () => {
    const tree = treeFor("reads")
    try {
      expect(await tree.paths()).toEqual(["README.md", "large.bin", "src.ts"])
      const after = server.requests.length
      expect(await tree.read("README.md")).toBe("# Plain app\n")
      expect(await tree.read("src.ts")).toBe("export const plain = 1\n")
      // Larger than the read limit: the first fetch left it out.
      expect(await tree.read("large.bin")).toBeNull()
      expect(await tree.read("missing.md")).toBeNull()
      expect(await tree.exists("src.ts")).toBe(true)
      // An evidence path that a step cites sends nothing to the host.
      expect(server.requests.slice(after)).toEqual([])
    } finally {
      await releaseIngestSourceTree(RUN_ID, sha, "reads")
    }
  })

  it("stops a host that does not send the pack in time", async () => {
    usePlainGitNetwork({ ...network, limits: { timeoutMs: 2_000 } })
    const started = Date.now()
    await expect(treeFor("slow", "slow").paths()).rejects.toThrow(
      /did not finish in 2000 ms/,
    )
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 30_000)

  it("stops a pack that is larger than the size limit", async () => {
    usePlainGitNetwork({ ...network, limits: { maxFileBytes: 64 * 1024 } })
    await expect(treeFor("large", "pack", largeSha).paths()).rejects.toThrow()
  }, 30_000)

  it("refuses a host that resolves to a cloud metadata address on self-host", async () => {
    usePlainGitNetwork({ lookup: async () => [{ address: "169.254.169.254" }] })
    const before = server.requests.length
    await expect(
      treeFor("metadata", "app", sha, "plain-git.invalid").paths(),
    ).rejects.toMatchObject({
      rule: "metadata_address",
    })
    expect(server.requests.length).toBe(before)
  })
})
