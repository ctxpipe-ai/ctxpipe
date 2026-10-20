import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { parseEnv } from "../../config/env.js"
import {
  ingestSourceTree,
  releaseIngestSourceTree,
} from "./ingest-source-tree.js"

/*
 * The host copy of the source tree has no blobs. The patch validator reads
 * the source text of a quote through it, so git must get the blob from the
 * source remote when the step asks for it.
 */

const RUN_ID = `run_source_tree_${Date.now()}`
const env = parseEnv({
  DATABASE_URL: "postgresql://fixture:fixture@localhost:5432/fixture",
  AUTH_SECRET: "x".repeat(32),
})
let dir: string
let url: string
let sha: string
let randomOid: string

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function commit(source: string): string {
  git(source, ["init", "--quiet"])
  git(source, ["add", "."])
  git(source, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ])
  // The remote serves partial fetches, so the copy has trees only.
  git(source, ["config", "uploadpack.allowFilter", "true"])
  git(source, ["config", "uploadpack.allowAnySHA1InWant", "true"])
  return git(source, ["rev-parse", "HEAD"])
}

function treeFor(holder: string, remote = url, commitSha = sha) {
  return ingestSourceTree({
    orgId: "org_fixture",
    runId: RUN_ID,
    source: {
      kind: "github" as const,
      url: remote,
      githubConnectionId: "con_fixture",
    },
    sha: commitSha,
    env,
    holder,
  })
}

/** The scratch copies that exist now. */
function copies() {
  return new Set(
    readdirSync(tmpdir()).filter((name) =>
      name.startsWith("ctxpipe-ingest-source-"),
    ),
  )
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-source-tree-"))
  const source = join(dir, "source")
  mkdirSync(join(source, "services/orders"), { recursive: true })
  mkdirSync(join(source, "src"))
  mkdirSync(join(source, "src2"))
  writeFileSync(
    join(source, "services/orders/README.md"),
    "Orders use idempotency keys.\n",
  )
  writeFileSync(join(source, "src/a.txt"), "inside src\n")
  writeFileSync(join(source, "src2/b.txt"), "inside src2\n")
  writeFileSync(join(source, "root.txt"), "at the root\n")
  symlinkSync("src/a.txt", join(source, "link"))
  writeFileSync(join(source, "large.txt"), "a".repeat(1024 * 1024 + 1))
  // Random bytes do not compress. The pack is larger than the read limit, even
  // in a shell whose `ulimit -f` counts 1024-byte blocks (twice the limit).
  writeFileSync(join(source, "random.bin"), randomBytes(3 * 1024 * 1024))
  sha = commit(source)
  randomOid = git(source, ["rev-parse", "HEAD:random.bin"])
  url = `file://${source}`
})

afterAll(async () => {
  for (const holder of ["run", "paths", "cap", "cache", "fault"])
    await releaseIngestSourceTree(RUN_ID, sha, holder)
  rmSync(dir, { recursive: true, force: true })
})

describe("ingestSourceTree", () => {
  it("reads the text of a source file, and null for a folder, a missing path, or a large file", async () => {
    const tree = treeFor("run")
    expect(await tree.exists("services/orders/README.md")).toBe(true)
    expect(await tree.read("services/orders/README.md")).toBe(
      "Orders use idempotency keys.\n",
    )
    expect(await tree.read("services/orders")).toBeNull()
    expect(await tree.read("services/missing.md")).toBeNull()
    expect(await tree.read("large.txt")).toBeNull()
  })

  it("returns null unless the entry path equals the requested path", async () => {
    const tree = treeFor("paths")
    expect(await tree.read("src/a.txt")).toBe("inside src\n")
    // A folder path does not return the first file in it.
    expect(await tree.read("src/")).toBeNull()
    expect(await tree.read("src")).toBeNull()
    // The root is a folder, not the first file in it.
    expect(await tree.read(".")).toBeNull()
    expect(await tree.read("")).toBeNull()
    // A prefix of a name or of a sibling folder is not that file.
    expect(await tree.read("src/a")).toBeNull()
    expect(await tree.read("sr")).toBeNull()
    expect(await tree.read("src2/a.txt")).toBeNull()
    expect(await tree.read("src2/b.txt")).toBe("inside src2\n")
  })

  it("returns the target text of a symlink, as the patch validator does", async () => {
    const tree = treeFor("paths")
    expect(await tree.read("link")).toBe("src/a.txt")
  })

  it("does not download a blob whose pack is larger than the read limit", async () => {
    const before = copies()
    const tree = treeFor("cap")
    expect(await tree.read("random.bin")).toBeNull()
    const held = [...copies()].filter((name) => !before.has(name))
    expect(held).toHaveLength(1)
    const repo = join(tmpdir(), held[0] ?? "")
    expect(() =>
      git(repo, ["--no-lazy-fetch", "cat-file", "-e", randomOid]),
    ).toThrow()
    // The refused download leaves no partial pack behind.
    const packs = join(repo, "objects/pack")
    expect(readdirSync(packs).filter((n) => n.startsWith("tmp_pack_"))).toEqual(
      [],
    )
    // A later read of a small file still works in the same copy.
    expect(await tree.read("root.txt")).toBe("at the root\n")
  })

  it("fetches a blob once for repeated reads", async () => {
    const trace = join(dir, "trace.json")
    const tree = treeFor("cache")
    await tree.paths()
    vi.stubEnv("GIT_TRACE2_EVENT", trace)
    try {
      expect(await tree.read("root.txt")).toBe("at the root\n")
      expect(await tree.read("root.txt")).toBe("at the root\n")
    } finally {
      vi.unstubAllEnvs()
    }
    const fetches = readFileSync(trace, "utf8").split(
      '"argv":["git-upload-pack"',
    )
    expect(fetches.length - 1).toBe(1)
  })

  it("throws when the remote fails, so the step is not blamed on the model", async () => {
    const lost = join(dir, "lost")
    mkdirSync(lost)
    writeFileSync(join(lost, "a.txt"), "gone soon\n")
    const lostSha = commit(lost)
    const tree = treeFor("fault", `file://${lost}`, lostSha)
    await tree.paths()
    rmSync(lost, { recursive: true, force: true })
    expect(existsSync(lost)).toBe(false)
    await expect(tree.read("a.txt")).rejects.toThrow()
    // A path that is not in the tree is still null, with no remote call.
    expect(await tree.read("missing.txt")).toBeNull()
    await releaseIngestSourceTree(RUN_ID, lostSha, "fault")
  })
})
