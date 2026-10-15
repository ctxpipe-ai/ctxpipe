import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { captureGitPack } from "../../services/git/pack.js"
import {
  ingestPublishChanges,
  readIngestPublishChanges,
} from "./extraction-source.js"

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
}
const SERVICE = "---\nkind: Service\nname: orders\n---\n# Orders\n"

let work: string
let pinned: string
let tip: string

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: work, env: ENV, encoding: "utf8" })
    .toString()
    .trim()
}

function write(path: string, content: string) {
  mkdirSync(dirname(join(work, path)), { recursive: true })
  writeFileSync(join(work, path), content)
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ingest-publish-"))
  git("init", "-q", "-b", "main")
  write("README.md", "# Context\n")
  write("knowledge/services/old.md", SERVICE)
  git("add", "-A")
  git("commit", "-q", "-m", "seed")
  pinned = git("rev-parse", "HEAD")
  write("knowledge/services/orders.md", SERVICE)
  git("rm", "-q", "knowledge/services/old.md")
  git("add", "-A")
  git(
    "commit",
    "-q",
    "-m",
    "skill:services/orders:apis:ws_1\n\nCtxpipe-Run: run_1\nCtxpipe-Step: assemble:ws_1",
  )
  tip = git("rev-parse", "HEAD")
})

afterAll(() => rmSync(work, { recursive: true, force: true }))

describe("readIngestPublishChanges", () => {
  it("reads the delta from the pinned revision to the assembled tip", async () => {
    const pack = await captureGitPack(work, pinned, [tip])
    const changes = await readIngestPublishChanges(pack, pinned, {
      runId: "run_1",
      tip,
      retract: true,
    })
    expect(changes.files.map((file) => file.path)).toEqual([
      "knowledge/services/orders.md",
    ])
    expect(changes.deletePaths).toEqual(["knowledge/services/old.md"])
  })

  it("keeps each deleted file of a partial Workspace (no retraction)", async () => {
    const pack = await captureGitPack(work, pinned, [tip])
    const changes = await readIngestPublishChanges(pack, pinned, {
      runId: "run_1",
      tip,
      retract: false,
    })
    expect(changes.files).toHaveLength(1)
    expect(changes.deletePaths).toEqual([])
  })

  it("refuses a tip that is not a commit of the run", async () => {
    const pack = await captureGitPack(work, pinned, [tip])
    await expect(
      readIngestPublishChanges(pack, pinned, {
        runId: "run_2",
        tip,
        retract: true,
      }),
    ).rejects.toThrow(/not a commit of the ingestion run/)
  })
})

describe("ingestPublishChanges", () => {
  it.each([
    ".ctxpipe/sources.yaml",
    "AGENTS.md",
    "notion/page.md",
    "README.md",
  ])("refuses a delta that changes %s", (path) => {
    expect(() =>
      ingestPublishChanges(
        { files: [{ path, content: "x" }], deletePaths: [] },
        true,
      ),
    ).toThrow(/The assembled ref changes/)
    expect(() =>
      ingestPublishChanges({ files: [], deletePaths: [path] }, false),
    ).toThrow(/The assembled ref changes/)
  })
})
