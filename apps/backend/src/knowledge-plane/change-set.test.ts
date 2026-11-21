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
  converter: "ctxpipe-convert 0.1.0 0000000000000000",
  visionModel: "vendor/vision",
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
    branch: "main",
    tip,
    projectionVersion: options.projectionVersion ?? version,
  })
}

/** The state after a completed run of `main` at `lastSha`. */
function started(lastSha: string) {
  return { lastSha, branch: "main", projectionVersion: version }
}

describe("planKnowledgeChangeSet", () => {
  it("gives the changed and the added files of the diff to the tip", async () => {
    const base = await commit({ "a.md": "a1", "b.md": "b1" })
    const tip = await commit({ "a.md": "a2", "c.md": "c1" })
    expect(await plan(started(base), tip)).toEqual({
      kind: "delta",
      changed: ["a.md", "c.md"],
      removed: [],
    })
  })

  it("gives a removed file as removed", async () => {
    const base = await commit({ "a.md": "a1", "b.md": "b1" })
    const tip = await commit({ "b.md": null })
    expect(await plan(started(base), tip)).toEqual({
      kind: "delta",
      changed: [],
      removed: ["b.md"],
    })
  })

  it("gives a rename as a removal and a change", async () => {
    const base = await commit({ "a.md": "the same text", "b.md": "b1" })
    git("mv", "a.md", "moved.md")
    const tip = await commit({})
    expect(await plan(started(base), tip)).toEqual({
      kind: "delta",
      changed: ["moved.md"],
      removed: ["a.md"],
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
      await plan({ lastSha: null, branch: null, projectionVersion: null }, tip),
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

    expect(await plan(started(lost), tip)).toEqual({
      kind: "full",
      reason: "missing_commit",
      files: ["a.md", "c.md"],
    })
  })

  it("rebuilds in full when the default branch is not the branch of the head", async () => {
    const base = await commit({ "a.md": "a1" })
    const tip = await commit({ "b.md": "b1" })
    expect(await plan({ ...started(base), branch: "master" }, tip)).toEqual({
      kind: "full",
      reason: "branch",
      files: ["a.md", "b.md"],
    })
  })

  it.each([
    { ...versionParts, embeddingModel: "another-model" },
    { ...versionParts, dimensions: 16 },
    { ...versionParts, root: "docs" },
    { ...versionParts, converter: "ctxpipe-convert 0.1.0 1111111111111111" },
    { ...versionParts, visionModel: "vendor/other-vision" },
  ])(
    "rebuilds in full when a part of the projection version changed (%o)",
    async (parts) => {
      const base = await commit({ "a.md": "a1" })
      const tip = await commit({ "b.md": "b1" })
      expect(
        await plan(started(base), tip, {
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
    expect(await plan(started(base), tip)).toEqual({
      kind: "full",
      reason: "sources_config",
      files: [sourcesFilePath, "a.md"],
    })
  })

  it("rebuilds in full when a source file changed", async () => {
    const source = "sources/linear/team.md"
    const base = await commit({ "a.md": "a1", [source]: "team: A" })
    const tip = await commit({ [source]: "team: B" })
    expect(await plan(started(base), tip)).toEqual({
      kind: "full",
      reason: "sources_config",
      files: ["a.md", source],
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
      await plan({ ...started(base), lastSha: null }, tip, {
        root: "docs",
      }),
    ).toEqual({
      kind: "full",
      reason: "first_run",
      files: [sourcesFilePath, "a.md"],
    })
    const next = await commit({ "docs/a.md": "a3", "outside.md": "o3" })
    expect(await plan(started(tip), next, { root: "docs" })).toEqual({
      kind: "delta",
      changed: ["a.md"],
      removed: [],
    })
  })
})
