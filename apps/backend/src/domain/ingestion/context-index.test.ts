import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { contextIndexAtStepBase } from "./context-index.js"

/*
 * The index of a step is built at the step base (ADR-052 section 6): a file
 * that an earlier step of the run wrote is in it, and a file that an earlier
 * step deleted is not. Real git; the projection is the pinned revision's.
 */

const SOURCE_URL = "https://github.com/example-org/shop"
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
}
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
  }).trim()

function commit(dir: string, files: Record<string, string | null>) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) git(dir, "rm", "-q", path)
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), content)
      git(dir, "add", path)
    }
  }
  git(dir, "commit", "-q", "--allow-empty", "-m", "step")
  return git(dir, "rev-parse", "HEAD")
}

const SERVICE = "knowledge/services/api.md"
const OLD = "knowledge/databases/old.md"
const API = "knowledge/apis/orders.md"
const OPERATION = "knowledge/operations/list.md"

describe("contextIndexAtStepBase", () => {
  it("adds the files of earlier steps and drops the files they deleted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-index-"))
    made.push(dir)
    git(dir, "init", "-q", "-b", "main")
    const pinned = commit(dir, {
      [SERVICE]: "---\nkind: Service\nname: api\n---\n# API service\n",
      [OLD]: "---\nkind: Database\nname: old\n---\n# Old store\n",
    })
    const base = commit(dir, {
      [OLD]: null,
      [API]: `---\nkind: API\nname: Orders API\nsummary: The orders API.\nclaims:\n  - to: ../operations/list.md\n    predicate: HAS_OPERATION\ngenerated_by: ctxpipe-extract\nsources:\n  - ${SOURCE_URL}\n---\n# Orders API\n\nServed by [api](../services/api.md).\n`,
      [OPERATION]:
        "---\nkind: Operation\nname: GET /orders\n---\n# GET /orders\n",
    })
    const { index } = await contextIndexAtStepBase({
      workspaceId: "ws_index",
      projection: [
        { path: SERVICE, kind: "Service", links: [] },
        { path: OLD, kind: "Database", links: [] },
      ],
      pinnedRevision: pinned,
      base,
      sourceUrl: SOURCE_URL,
      repoDir: dir,
    })
    expect(index.revision).toBe(base)
    expect(index.entries.map((e) => e.path)).toEqual([API, OPERATION, SERVICE])
    expect(index.entries[0]).toEqual({
      path: API,
      kind: "API",
      title: "Orders API",
      summary: "The orders API.",
      // A claim target is a link, as a Markdown link is.
      links: [OPERATION, SERVICE],
      sources: [SOURCE_URL],
      owned: true,
    })
  })

  it("is the pinned projection when the base is the pinned revision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-index-"))
    made.push(dir)
    git(dir, "init", "-q", "-b", "main")
    const pinned = commit(dir, {
      [SERVICE]: "---\nkind: Service\nname: api\n---\n# API service\n",
    })
    const { index } = await contextIndexAtStepBase({
      workspaceId: "ws_index",
      projection: [{ path: SERVICE, kind: "Service", links: [] }],
      pinnedRevision: pinned,
      base: pinned,
      sourceUrl: SOURCE_URL,
      repoDir: dir,
    })
    expect(index.entries.map((e) => [e.path, e.owned])).toEqual([
      [SERVICE, false],
    ])
  })
})
