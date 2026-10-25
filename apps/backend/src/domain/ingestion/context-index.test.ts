import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { contextIndexAtStepBase, stepContextIndex } from "./context-index.js"

/*
 * The index of a step is built at the step base (ADR-052 section 6): a file
 * that an earlier step of the run wrote is in it, and a file that an earlier
 * step deleted is not. Real git; the projection is the pinned revision's.
 */

// The source file path of the run (`sources`, ADR-050 revision 2026-10-16).
const SOURCE_PATH = "sources/github/example-org/shop.md"
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
      [API]: `---\nkind: API\nname: Orders API\nsummary: The orders API.\nclaims:\n  - to: ../operations/list.md\n    predicate: HAS_OPERATION\ngenerated_by: ctxpipe-extract\nsources:\n  - ${SOURCE_PATH}\n---\n# Orders API\n\nServed by [api](../services/api.md).\n`,
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
      sourcePath: SOURCE_PATH,
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
      sources: [SOURCE_PATH],
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
      sourcePath: SOURCE_PATH,
      repoDir: dir,
    })
    expect(index.entries.map((e) => [e.path, e.owned])).toEqual([
      [SERVICE, false],
    ])
  })
  it("reads the files below the Workspace root folder with root-relative paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-index-"))
    made.push(dir)
    git(dir, "init", "-q", "-b", "main")
    const pinned = commit(dir, {
      [`docs/ctx/${SERVICE}`]:
        "---\nkind: Service\nname: api\nsummary: Inside.\n---\n# API\n",
      [SERVICE]: "---\nkind: Service\nname: api\nsummary: Outside.\n---\n",
    })
    const base = commit(dir, {
      [`docs/ctx/${OPERATION}`]:
        "---\nkind: Operation\nname: GET /orders\n---\n# GET /orders\n",
      [OLD]: "---\nkind: Database\nname: old\n---\n# Outside\n",
    })
    const { index } = await contextIndexAtStepBase({
      workspaceId: "ws_index",
      projection: [{ path: SERVICE, kind: "Service", links: [] }],
      pinnedRevision: pinned,
      base,
      sourcePath: SOURCE_PATH,
      repoDir: dir,
      rootPath: "docs/ctx",
    })
    expect(index.entries.map((e) => [e.path, e.summary])).toEqual([
      [OPERATION, null],
      [SERVICE, "Inside."],
    ])
  })
})

describe("stepContextIndex", () => {
  it("keeps one scratch repository for a Workspace, fetches only new commits, and parses only changed files", async () => {
    const work = mkdtempSync(join(tmpdir(), "context-index-work-"))
    const scratch = mkdtempSync(join(tmpdir(), "context-index-scratch-"))
    made.push(work, scratch)
    git(work, "init", "-q", "-b", "main")
    const pinned = commit(work, {
      [SERVICE]: "---\nkind: Service\nname: api\n---\n# API service\n",
      [OLD]: "---\nkind: Database\nname: old\n---\n# Old store\n",
    })
    const first = commit(work, {
      [API]: `---\nkind: API\nname: Orders API\nsources:\n  - ${SOURCE_PATH}\n---\n# Orders API\n\nServed by [api](../services/api.md).\n`,
      [OPERATION]:
        "---\nkind: Operation\nname: GET /orders\n---\n# GET /orders\n",
    })
    git(work, "update-ref", "refs/ctxpipe/ingest/run/ws/shards/0", first)
    git(scratch, "init", "-q", "--bare")
    const fetched: string[] = []
    let projections = 0
    const projection = [
      { path: SERVICE, kind: "Service", links: [] },
      { path: OLD, kind: "Database", links: [] },
    ]
    const index = stepContextIndex({
      workspaceId: "ws_index",
      pinnedRevision: pinned,
      sourcePath: SOURCE_PATH,
      repoDir: scratch,
      projection: async () => {
        projections++
        return projection
      },
      fetch: async (what, into) => {
        fetched.push(what)
        git(scratch, "fetch", "-q", "--no-tags", work, `+${what}:${into}`)
      },
    })
    const ref = "refs/ctxpipe/ingest/run/ws/shards/0"

    const atFirst = await index.at(first, ref)
    expect(fetched).toEqual([pinned, ref])
    expect(index.parsed).toBe(2)
    expect(atFirst.json).toBe(
      (
        await contextIndexAtStepBase({
          workspaceId: "ws_index",
          projection,
          pinnedRevision: pinned,
          base: first,
          sourcePath: SOURCE_PATH,
          repoDir: work,
        })
      ).json,
    )

    // The next step: one changed file and one deleted file.
    const second = commit(work, {
      [OPERATION]:
        "---\nkind: Operation\nname: GET /orders/{id}\n---\n# GET /orders/{id}\n",
      [OLD]: null,
    })
    git(work, "update-ref", ref, second)
    const atSecond = await index.at(second, ref)
    expect(fetched).toEqual([pinned, ref, ref])
    expect(index.parsed).toBe(3)
    expect(projections).toBe(1)
    expect(atSecond.index.entries.map((e) => [e.path, e.title])).toEqual([
      [API, "Orders API"],
      [OPERATION, "GET /orders/{id}"],
      [SERVICE, "api"],
    ])
    expect(atSecond.json).toBe(
      (
        await contextIndexAtStepBase({
          workspaceId: "ws_index",
          projection,
          pinnedRevision: pinned,
          base: second,
          sourcePath: SOURCE_PATH,
          repoDir: work,
        })
      ).json,
    )

    // The same base again: no fetch and no parse.
    await index.at(second, ref)
    expect(fetched).toHaveLength(3)
    expect(index.parsed).toBe(3)
  })
})
