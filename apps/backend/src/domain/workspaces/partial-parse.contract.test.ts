import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { eq, type SQL, sql } from "drizzle-orm"
import { expect, it, vi } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceKnowledgeUnits } from "../../db/schema/workspaces.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { readGitFiles, readGitPackFromRemote } from "../../services/git/pack.js"
import {
  type Change,
  commit,
  countEmbeddings,
  expectPartialEqualsFull,
  type HydrateResult,
  hydrate,
} from "../../test/hydrate-projection.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { folderSetChanged } from "./folder-list.js"
import {
  hydratePlanParseOfFiles,
  planHydrateWrites,
} from "./hydrate-write-planner.js"
import { nativeRenameRewriteFiles } from "./native-rename-rewrite.js"
import {
  readWorkspaceFormat,
  WORKSPACE_FORMAT_PATH,
  workspaceFormatCacheValue,
} from "./workspace-format.js"

// 24 documents and 4 mirror files: a partial write takes at most 3 changed
// or removed units (`partialUnitBound`). The documents name the mirror files
// by Linear identifier and by GitHub URL, so a change of a mirror file
// changes the links of documents that do not change.
const docs = Array.from({ length: 24 }, (_, index) => {
  const name = (n: number) => `knowledge/doc-${String(n).padStart(2, "0")}.md`
  const mention: Record<number, string> = {
    2: "The work continues in ENG-7.\n",
    4: "This closes ENG-1.\n",
    6: "See https://github.com/fixture/other/issues/13 for the bug.\n",
    7: "See https://github.com/fixture/other/issues/12 for the bug.\n",
  }
  const front =
    index === 3
      ? "---\nclaims:\n  - to: doc-05.md\n    predicate: DEPENDS_ON\n    confidence: 0.7\n---\n"
      : ""
  return {
    path: name(index),
    body: `${front}# Doc ${index}\nSee [the next doc](${name((index + 1) % 24).slice("knowledge/".length)}).\n${mention[index] ?? ""}\n## Part ${index}\nText of part ${index}.\n`,
  }
})
const linearIssue = (identifier: string) => ({
  path: `linear/teams/ENG/issues/${identifier}.md`,
  body: `---\nidentifier: ${identifier}\ntitle: Issue ${identifier}\n---\n# ${identifier}\nThe issue text.\n`,
})
const githubIssue = (number: number) =>
  `---\nurl: https://github.com/fixture/other/issues/${number}\n---\n# Issue ${number}\nThe issue text.\n`
const files = [
  ...docs,
  linearIssue("ENG-1"),
  linearIssue("ENG-2"),
  { path: "github/issues/fixture/other/12.md", body: githubIssue(12) },
  {
    path: "knowledge/notes.md",
    body: "# Notes\nPlain notes with [a link](doc-01.md).\n",
  },
]

/** A fixture whose hydrate plans writes: GitHub, format 3, writable. */
const withFixture = (
  test: (f: NativeHydrationFixture) => Promise<void>,
  more: Array<{ path: string; body: string }> = [],
) =>
  withNativeHydrationFixture(
    {
      github: true,
      format: 3,
      githubWriteView: "writable",
      writeStatus: "writable",
      files: [...files, ...more],
    },
    test,
  )

/** The output of the plan step of the last hydrate run. */
async function lastPlan(f: NativeHydrationFixture) {
  const runs = (await f.backend.listWorkflowRuns({ limit: 100 })).data
    .filter(
      (run) =>
        run.workflowName === "workspace-hydrate" &&
        (run.input as { workspaceId?: string }).workspaceId === f.workspaceId,
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const [run] = runs
  if (!run) throw new Error("Expected a hydrate run")
  const steps = await f.backend.listStepAttempts({ workflowRunId: run.id })
  return steps.data.find((step) => step.stepName === "plan-remaining-writes")
    ?.output
}

/**
 * The plan of a full parse of the tip: each file of the work tree and the
 * history from a Git pack of the two SHAs, as the planner read them before
 * the partial parse.
 */
async function fullPlan(f: NativeHydrationFixture, previousSha: string) {
  const revision = await f.resolveRevision()
  const paths = execFileSync("git", ["-C", f.directory, "ls-files"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
  const tree = paths.map((path) => ({
    path,
    content: readFileSync(join(f.directory, path), "utf8"),
  }))
  // The fixture Workspace is the repository root.
  const pathsAt = (sha: string) =>
    f.git("ls-tree", "-r", "--name-only", sha).split("\n").filter(Boolean)
  const formatFile =
    tree.find((file) => file.path === WORKSPACE_FORMAT_PATH)?.content ?? null
  const workspace = await withOrgIdContext(f.org, () =>
    getWorkspaceById(f.workspaceId),
  )
  const pack = await readGitPackFromRemote({
    url: f.remote,
    sha: revision.sha,
    additionalShas: [previousSha],
  })
  const [previousFormatFile] = await readGitFiles(
    { ...pack, sha: previousSha },
    (path) => path === WORKSPACE_FORMAT_PATH,
    undefined,
    null,
  )
  return planHydrateWrites({
    revision,
    displayName: workspace?.displayName ?? "",
    parsed: hydratePlanParseOfFiles(revision, tree),
    sourceFiles: [],
    sourceRows: [],
    format: workspaceFormatCacheValue(readWorkspaceFormat(formatFile)),
    history: {
      previousSha,
      previousFormat: workspaceFormatCacheValue(
        readWorkspaceFormat(previousFormatFile?.content ?? null),
      ),
      renameRewrites: (await nativeRenameRewriteFiles(pack, previousSha, null))
        .length,
      folderSetChanged: folderSetChanged(
        pathsAt(previousSha),
        pathsAt(revision.sha),
      ),
    },
  })
}

/**
 * Commit `change`, hydrate the tip with a partial parse, and expect the
 * projection and the plan of a full parse.
 */
async function expectPartialParse(
  f: NativeHydrationFixture,
  change: Change,
  expected: { parsed: number; written: number },
) {
  const base = f.git("rev-parse", "HEAD")
  await commit(f, change)
  await f.resolveRevision(true)
  const partial = await hydrate(f)
  expect(partial.writes).toMatchObject({
    parseMode: "partial",
    filesParsed: expected.parsed,
    unitRowsWritten: expected.written,
    unitRowsDeleted: change.remove?.length ?? 0,
  })
  const plan = await fullPlan(f, base)
  // The fixture has writes to plan (for example the bootstrap files).
  expect(plan.length).toBeGreaterThan(0)
  expect(await lastPlan(f)).toEqual(plan)
  await expectPartialEqualsFull(f, partial)
}

const cases: Array<{
  name: string
  change: Change
  parsed: number
  written: number
}> = [
  {
    name: "an added file",
    change: {
      write: { "knowledge/new.md": "# New\nBack to [doc 1](doc-01.md).\n" },
    },
    parsed: 1,
    written: 1,
  },
  {
    name: "a modified file",
    change: {
      write: {
        "knowledge/doc-05.md":
          "---\nclaims:\n  - to: doc-07.md\n    predicate: SUPERSEDES\n---\n# Doc 5\nNew text that links to [doc 9](doc-09.md).\n\n## Part 5\nText of part 5.\n",
      },
    },
    parsed: 1,
    written: 1,
  },
  {
    name: "a renamed file",
    change: {
      write: {
        "knowledge/moved/doc-07.md": (docs[7]?.body ?? "").replace(
          "(doc-08.md)",
          "(../doc-08.md)",
        ),
      },
      remove: ["knowledge/doc-07.md"],
    },
    parsed: 1,
    written: 1,
  },
  {
    name: "a deleted file",
    change: { remove: ["knowledge/doc-09.md"] },
    parsed: 0,
    written: 0,
  },
  {
    // doc-02 names ENG-7 and does not change: it gets the link.
    name: "a new Linear issue file that an unchanged unit names by identifier",
    change: {
      write: {
        [linearIssue("ENG-7").path]: linearIssue("ENG-7").body,
      },
    },
    parsed: 1,
    written: 2,
  },
  {
    // doc-04 names ENG-1 and does not change: it loses the link.
    name: "a removed file that an unchanged unit links to",
    change: { remove: [linearIssue("ENG-1").path] },
    parsed: 0,
    written: 1,
  },
  {
    // The issue moves from URL 12 to URL 13: doc-07 loses its link, and
    // doc-06 gets one. Neither document changes.
    name: "a changed URL key",
    change: {
      write: { "github/issues/fixture/other/12.md": githubIssue(13) },
    },
    parsed: 1,
    written: 3,
  },
]

it.each(cases)(
  "a partial parse of $name gives the projection and the plan of a full hydrate",
  { timeout: 180_000 },
  async ({ change, parsed, written }) =>
    withFixture(async (f) => {
      await f.publish()
      expect(await f.handle.result()).toMatchObject({
        writes: { parseMode: "full", parseFullReason: "full_write" },
      })
      await expectPartialParse(f, change, { parsed, written })
    }),
)

it(
  "a partial parse across a merge commit gives the projection of a full hydrate",
  { timeout: 180_000 },
  async () =>
    withFixture(async (f) => {
      await f.publish()
      // Each commit has its own time, so the commit times of the changed
      // files show which commit the read takes.
      const commitAt = (date: string, path: string, body: string) => {
        vi.stubEnv("GIT_AUTHOR_DATE", date)
        vi.stubEnv("GIT_COMMITTER_DATE", date)
        writeFileSync(join(f.directory, path), body)
        f.git("add", "-A")
        f.git("commit", "-q", "-m", `Change ${path}`)
      }
      try {
        f.git("checkout", "--", ".")
        const trunk = f.git("rev-parse", "--abbrev-ref", "HEAD")
        f.git("checkout", "-q", "-b", "side")
        commitAt(
          "2026-01-01T00:00:00Z",
          "knowledge/doc-05.md",
          "# Doc 5\nSide.\n",
        )
        f.git("checkout", "-q", trunk)
        commitAt(
          "2026-01-02T00:00:00Z",
          "knowledge/doc-06.md",
          "# Doc 6\nTrunk.\n",
        )
        vi.stubEnv("GIT_AUTHOR_DATE", "2026-01-03T00:00:00Z")
        vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-03T00:00:00Z")
        f.git("merge", "-q", "--no-ff", "-m", "Merge side", "side")
        f.git("push", "-q", f.remote, "HEAD:refs/heads/main")
      } finally {
        vi.unstubAllEnvs()
      }
      await f.resolveRevision(true)
      const partial = await hydrate(f)
      expect(partial.writes).toMatchObject({
        parseMode: "partial",
        filesParsed: 2,
      })
      await expectPartialEqualsFull(f, partial)
    }),
)

it(
  "a one-file commit in a large Workspace reads and parses only the changed file and the control files",
  { timeout: 300_000 },
  async () =>
    withFixture(
      async (f) => {
        await f.publish()
        await commit(f, {
          write: { "knowledge/doc-01.md": "# Doc 1\nA new body.\n" },
        })
        await f.resolveRevision(true)
        const partial = (await hydrate(f)) as HydrateResult & {
          writes: { filesRead: number; filesParsed: number }
        }
        expect(partial.writes).toMatchObject({
          parseMode: "partial",
          filesParsed: 1,
        })
        // The fixture has no control file: the read gets the changed file
        // only, nothing that grows with the number of files.
        expect(partial.writes.filesRead).toBe(1)
      },
      Array.from({ length: 400 }, (_, index) => ({
        path: `knowledge/bulk/file-${index}.md`,
        body: `# File ${index}\nText ${index}.\n`,
      })),
    ),
)

/**
 * Change the stored row of one unit, as a row of an older hydrate is: its
 * hash is not the hash of the new code, so the next hydrate writes it again.
 */
const editRow = (
  f: NativeHydrationFixture,
  values: { referenceIndex?: SQL | null; source?: string; title?: string },
) =>
  withOrgDbContext(f.org.id, (db) =>
    db
      .update(workspaceKnowledgeUnits)
      .set({ ...values, unitHash: null })
      .where(eq(workspaceKnowledgeUnits.path, "knowledge/notes.md")),
  )

it.each([
  {
    reason: "no_reference_index",
    prepare: (f: NativeHydrationFixture) =>
      editRow(f, { referenceIndex: null }),
  },
  {
    // A row of an older parser: another version and another title. The
    // title is not in the index, but the version covers it too.
    reason: "reference_index_version",
    prepare: (f: NativeHydrationFixture) =>
      editRow(f, {
        referenceIndex: sql`jsonb_set(${workspaceKnowledgeUnits.referenceIndex}, '{version}', '0')`,
        title: "A title of an older parser",
      }),
  },
  {
    reason: "legacy_overlay",
    prepare: (f: NativeHydrationFixture) => editRow(f, { source: "legacy" }),
  },
  {
    reason: "base_not_ancestor",
    prepare: async (f: NativeHydrationFixture) => {
      // A force push replaces the history: the base is not an ancestor of
      // the new tip.
      f.git("checkout", "-q", "--orphan", "rewritten")
      f.git("commit", "-q", "-m", "Rewritten history")
      f.git("push", "-q", "-f", f.remote, "HEAD:refs/heads/main")
    },
  },
])(
  "a hydrate parses all files when the reason is $reason",
  { timeout: 180_000 },
  async ({ reason, prepare }) =>
    withFixture(async (f) => {
      await f.publish()
      await prepare(f)
      await commit(f, {
        write: { "knowledge/doc-02.md": "# Doc 2\nChanged.\n" },
      })
      await f.resolveRevision(true)
      const result = await hydrate(f)
      expect(result).toMatchObject({
        hydrated: true,
        writes: { parseMode: "full", parseFullReason: reason },
      })
      const [notes] = await withOrgDbContext(f.org.id, (db) =>
        db
          .select({ title: workspaceKnowledgeUnits.title })
          .from(workspaceKnowledgeUnits)
          .where(eq(workspaceKnowledgeUnits.path, "knowledge/notes.md")),
      )
      expect(notes?.title).toBe("Notes")
      // The full parse writes the index again: the next commit parses only
      // its file.
      await commit(f, {
        write: { "knowledge/doc-03.md": "# Doc 3\nChanged too.\n" },
      })
      await f.resolveRevision(true)
      expect((await hydrate(f)).writes).toMatchObject({
        parseMode: "partial",
        filesParsed: 1,
      })
    }),
)

it(
  "a fix of a file that the base skipped parses all files, so its claims get the time of the commit that added it",
  { timeout: 180_000 },
  async () =>
    withFixture(async (f) => {
      await f.publish()
      await f.handle.result()
      await commit(f, {
        write: {
          "knowledge/conflict.md":
            "# Conflict\n<<<<<<< ours\nOne.\n=======\nTwo.\n>>>>>>> theirs\n",
        },
      })
      await f.resolveRevision(true)
      expect(await hydrate(f)).toMatchObject({
        skipped: 1,
        writes: { parseMode: "partial" },
      })
      await commit(f, {
        write: {
          "knowledge/conflict.md":
            "---\nclaims:\n  - to: doc-05.md\n    predicate: DEPENDS_ON\n---\n# Fixed\nOne version.\n",
        },
      })
      await f.resolveRevision(true)
      expect((await hydrate(f)).writes).toMatchObject({
        parseMode: "full",
        parseFullReason: "skipped_file_changed",
      })
      const [fixed] = await withOrgDbContext(f.org.id, (db) =>
        db
          .select({ claims: workspaceKnowledgeUnits.claims })
          .from(workspaceKnowledgeUnits)
          .where(eq(workspaceKnowledgeUnits.path, "knowledge/conflict.md")),
      )
      expect(fixed?.claims).toEqual([
        expect.objectContaining({
          predicate: "DEPENDS_ON",
          validFrom: expect.stringMatching(/^\d{4}-/),
        }),
      ])
    }),
)

it(
  "a partial parse whose commit needs a full write parses all files",
  { timeout: 180_000 },
  async () =>
    withFixture(async (f) => {
      await f.publish()
      await commit(f, {
        write: Object.fromEntries(
          [1, 2, 3, 4].map((n) => [
            `knowledge/doc-0${n}.md`,
            `# Doc ${n}\nChanged.\n`,
          ]),
        ),
      })
      await f.resolveRevision(true)
      expect(await hydrate(f)).toMatchObject({
        hydrated: true,
        writes: {
          mode: "full",
          fullReason: "unit_bound",
          parseMode: "full",
          parseFullReason: "full_write",
        },
      })
    }),
)

it(
  "a hydrate after a change of the embedding model parses all files and embeds each chunk again",
  { timeout: 180_000 },
  async () =>
    withFixture(async (f) => {
      await f.publish()
      await f.handle.result()
      vi.stubEnv("MODEL_EMBEDDING_NAME", "openai/fixture-other-embedding")
      try {
        const embedded = countEmbeddings(f)
        await commit(f, {
          write: { "knowledge/doc-02.md": "# Doc 2\nChanged.\n" },
        })
        await f.resolveRevision(true)
        expect((await hydrate(f)).writes).toMatchObject({
          parseMode: "full",
          parseFullReason: "embedding_model",
          mode: "full",
          fullReason: "unit_bound",
          unitRowsWritten: files.length,
        })
        // Each unit has more than one chunk, so the hydrate embeds more
        // texts than units.
        expect(embedded.length).toBeGreaterThan(files.length)
        await commit(f, {
          write: { "knowledge/doc-03.md": "# Doc 3\nChanged too.\n" },
        })
        await f.resolveRevision(true)
        expect((await hydrate(f)).writes).toMatchObject({
          parseMode: "partial",
          filesParsed: 1,
        })
      } finally {
        vi.unstubAllEnvs()
      }
    }),
)
