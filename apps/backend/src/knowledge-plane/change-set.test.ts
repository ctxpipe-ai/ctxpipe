import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  type KnowledgePlanState,
  knowledgeProjectionVersion,
  planKnowledgeChangeSet,
} from "./change-set.js"

const versionParts = {
  embeddingModel: "test-embedding-model",
  dimensions: 8,
  root: "",
}
const version = knowledgeProjectionVersion(versionParts)
const sourcesFilePath = ".ctxpipe/sources.yaml"

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "knowledge-change-set-"))
  git("init", "-q", "-b", "main")
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-C",
      directory,
      ...args,
    ],
    { encoding: "utf8" },
  ).trim()
}

/** Write (string) or remove (null) each file, commit, and give the SHA. */
async function commit(files: Record<string, string | null>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) git("rm", "-q", path)
    else {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await writeFile(join(directory, path), content)
      git("add", path)
    }
  }
  git("commit", "-q", "--allow-empty", "-m", "change")
  return git("rev-parse", "HEAD")
}

function plan(
  state: KnowledgePlanState | null,
  tip: string,
  options: { root?: string; projectionVersion?: string } = {},
) {
  return planKnowledgeChangeSet({
    directory,
    root: options.root ?? "",
    state,
    tip,
    projectionVersion: options.projectionVersion ?? version,
  })
}

/** The state after `lastSha`, with these SHAs in `attempt_shas` (the tip included). */
function started(lastSha: string, ...attemptShas: string[]) {
  return { lastSha, attemptShas, projectionVersion: version }
}

describe("planKnowledgeChangeSet", () => {
  it("gives the changed and the added files of the diff to the tip", async () => {
    const base = await commit({ "a.md": "a1", "b.md": "b1" })
    const tip = await commit({ "a.md": "a2", "c.md": "c1" })
    expect(await plan(started(base, tip), tip)).toEqual({
      kind: "delta",
      changed: ["a.md", "c.md"],
      removed: [],
    })
  })

  it("gives a removed file as removed", async () => {
    const base = await commit({ "a.md": "a1", "b.md": "b1" })
    const tip = await commit({ "b.md": null })
    expect(await plan(started(base, tip), tip)).toEqual({
      kind: "delta",
      changed: [],
      removed: ["b.md"],
    })
  })

  it("gives a rename as a removal and a change", async () => {
    const base = await commit({ "a.md": "the same text", "b.md": "b1" })
    git("mv", "a.md", "moved.md")
    const tip = await commit({})
    expect(await plan(started(base, tip), tip)).toEqual({
      kind: "delta",
      changed: ["moved.md"],
      removed: ["a.md"],
    })
  })

  it("applies again each file of a failed run, also when a later commit changed it back", async () => {
    const base = await commit({ "a.md": "a1", "b.md": "b1" })
    // The failed run: it can have written a.md and new.md, and made b.md a
    // tombstone.
    const failed = await commit({ "a.md": "a2", "b.md": null, "new.md": "n" })
    // The next commit changes each of them back.
    const tip = await commit({ "a.md": "a1", "b.md": "b1", "new.md": null })
    expect(git("diff", "--name-only", base, tip)).toBe("")

    expect(await plan(started(base, failed, tip), tip)).toEqual({
      kind: "delta",
      changed: ["a.md", "b.md"],
      removed: ["new.md"],
    })
    // Without the failed SHA, the diff is empty and the stale rows stay.
    expect(await plan(started(base, tip), tip)).toEqual({
      kind: "delta",
      changed: [],
      removed: [],
    })
  })

  it("rebuilds in full before the first completed run", async () => {
    const tip = await commit({ "a.md": "a1", "notes/b.md": "b1" })
    expect(await plan(null, tip)).toEqual({
      kind: "full",
      reason: "first_run",
      files: ["a.md", "notes/b.md"],
    })
    expect(
      await plan(
        { lastSha: null, attemptShas: [tip], projectionVersion: null },
        tip,
      ),
    ).toMatchObject({ kind: "full", reason: "first_run" })
  })

  it("rebuilds in full when the old commit is missing", async () => {
    await commit({ "a.md": "a1" })
    const lost = await commit({ "b.md": "b1" })
    // A force-push and a Git GC remove the last applied commit.
    git("reset", "-q", "--hard", "HEAD~1")
    git("reflog", "expire", "--expire=now", "--all")
    git("gc", "-q", "--prune=now")
    const tip = await commit({ "c.md": "c1" })

    expect(await plan(started(lost, tip), tip)).toEqual({
      kind: "full",
      reason: "missing_commit",
      files: ["a.md", "c.md"],
    })
  })

  it("rebuilds in full when a SHA of a failed run is missing", async () => {
    const base = await commit({ "a.md": "a1" })
    const tip = await commit({ "a.md": "a2" })
    const missing = "0123456789abcdef0123456789abcdef01234567"
    expect(await plan(started(base, missing, tip), tip)).toMatchObject({
      kind: "full",
      reason: "missing_commit",
    })
  })

  it.each([
    { ...versionParts, embeddingModel: "another-model" },
    { ...versionParts, dimensions: 16 },
    { ...versionParts, root: "docs" },
  ])(
    "rebuilds in full when a part of the projection version changed (%o)",
    async (parts) => {
      const base = await commit({ "a.md": "a1" })
      const tip = await commit({ "b.md": "b1" })
      expect(
        await plan(started(base, tip), tip, {
          projectionVersion: knowledgeProjectionVersion(parts),
        }),
      ).toEqual({
        kind: "full",
        reason: "projection_version",
        files: ["a.md", "b.md"],
      })
    },
  )

  it("rebuilds in full when the sources config file changed", async () => {
    const base = await commit({ "a.md": "a1", [sourcesFilePath]: "v: 1" })
    const tip = await commit({ [sourcesFilePath]: "v: 2" })
    expect(await plan(started(base, tip), tip)).toEqual({
      kind: "full",
      reason: "sources_config",
      files: [sourcesFilePath, "a.md"],
    })
  })

  it("rebuilds in full when a source file changed", async () => {
    const source = "sources/linear/team.md"
    const base = await commit({ "a.md": "a1", [source]: "team: A" })
    const tip = await commit({ [source]: "team: B" })
    expect(await plan(started(base, tip), tip)).toEqual({
      kind: "full",
      reason: "sources_config",
      files: ["a.md", source],
    })
  })

  it("rebuilds in full when only a failed run changed the sources", async () => {
    const source = "sources/linear/team.md"
    const base = await commit({
      "a.md": "a1",
      [sourcesFilePath]: "v: 1",
      [source]: "team: A",
    })
    const failed = await commit({ [sourcesFilePath]: "v: 2" })
    const tip = await commit({ [sourcesFilePath]: "v: 1" })
    expect(await plan(started(base, failed, tip), tip)).toMatchObject({
      kind: "full",
      reason: "sources_config",
    })
    const failedSource = await commit({ [source]: "team: B" })
    const revert = await commit({ [source]: "team: A" })
    expect(
      await plan(started(tip, failedSource, revert), revert),
    ).toMatchObject({ kind: "full", reason: "sources_config" })
  })

  it("rebuilds in full when the list has more than 10 SHAs", async () => {
    const base = await commit({ "a.md": "a0" })
    const shas: string[] = []
    for (let at = 1; at <= 11; at++)
      shas.push(await commit({ "a.md": `a${at}` }))
    const tip = shas[10] ?? ""

    // Ten SHAs, the tip included: still a delta.
    expect(await plan(started(base, ...shas.slice(1)), tip)).toEqual({
      kind: "delta",
      changed: ["a.md"],
      removed: [],
    })
    // Eleven SHAs: a full rebuild.
    expect(await plan(started(base, ...shas), tip)).toMatchObject({
      kind: "full",
      reason: "attempts",
    })
  })

  it("gives paths relative to the Workspace root folder", async () => {
    const base = await commit({ "docs/a.md": "a1", "outside.md": "o1" })
    const tip = await commit({
      "docs/a.md": "a2",
      "docs/.ctxpipe/sources.yaml": "v: 1",
      "outside.md": "o2",
    })
    expect(
      await plan({ ...started(base, tip), lastSha: null }, tip, {
        root: "docs",
      }),
    ).toEqual({
      kind: "full",
      reason: "first_run",
      files: [sourcesFilePath, "a.md"],
    })
    const next = await commit({ "docs/a.md": "a3", "outside.md": "o3" })
    expect(await plan(started(tip, next), next, { root: "docs" })).toEqual({
      kind: "delta",
      changed: ["a.md"],
      removed: [],
    })
  })
})
