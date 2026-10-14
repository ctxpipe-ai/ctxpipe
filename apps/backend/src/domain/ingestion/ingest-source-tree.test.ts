import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-source-tree-"))
  const source = join(dir, "source")
  mkdirSync(join(source, "services/orders"), { recursive: true })
  writeFileSync(
    join(source, "services/orders/README.md"),
    "Orders use idempotency keys.\n",
  )
  writeFileSync(join(source, "large.txt"), "a".repeat(1024 * 1024 + 1))
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
  sha = git(source, ["rev-parse", "HEAD"])
  url = `file://${source}`
})

afterAll(async () => {
  await releaseIngestSourceTree(RUN_ID, sha)
  rmSync(dir, { recursive: true, force: true })
})

describe("ingestSourceTree", () => {
  it("reads the text of a source file, and null for a folder, a missing path, or a large file", async () => {
    const tree = ingestSourceTree({
      orgId: "org_fixture",
      runId: RUN_ID,
      source: { url, githubConnectionId: "con_fixture" },
      sha,
      env,
    })
    expect(await tree.exists("services/orders/README.md")).toBe(true)
    expect(await tree.read("services/orders/README.md")).toBe(
      "Orders use idempotency keys.\n",
    )
    expect(await tree.read("services/orders")).toBeNull()
    expect(await tree.read("services/missing.md")).toBeNull()
    expect(await tree.read("large.txt")).toBeNull()
  })
})
