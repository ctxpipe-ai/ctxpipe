import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compareShadowRun, readMarkdownTree } from "./ingestion-compare-run.js"
import { runGit } from "./run-git.js"

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ctxpipe-compare-tree-"))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function commit(work: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true })
    await writeFile(join(work, path), content)
  }
  await runGit(work, ["add", "-A"])
  await runGit(work, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--quiet",
    "-m",
    "Fixture",
  ])
  return (await runGit(work, ["rev-parse", "HEAD"])).toString("utf8").trim()
}

describe("readMarkdownTree", () => {
  it("reads the Markdown files of the default branch and of a ref-only commit", async () => {
    const bare = join(root, "context.git")
    const work = join(root, "work")
    await runGit(root, ["init", "--quiet", "--bare", "-b", "main", bare])
    await runGit(root, ["init", "--quiet", "-b", "main", work])
    const base = await commit(work, {
      "AGENTS.md": "# Context\n",
      "knowledge/services/a b.md": "# A\n\nÜnïcode text.\n",
      "knowledge/data.json": "{}",
    })
    const tip = await commit(work, {
      "knowledge/streams/orders.md": "# Orders\n",
    })
    await runGit(work, ["push", "--quiet", bare, `${base}:refs/heads/main`])
    await runGit(work, [
      "push",
      "--quiet",
      bare,
      `${tip}:refs/ctxpipe/ingest/wr1/ws1/assembled`,
    ])
    const remote = { url: `file://${bare}` }

    const head = await readMarkdownTree(remote, "HEAD")
    expect(head.commit).toBe(base)
    expect(head.files).toEqual([
      { path: "AGENTS.md", content: "# Context\n" },
      { path: "knowledge/services/a b.md", content: "# A\n\nÜnïcode text.\n" },
    ])

    const shadow = await readMarkdownTree(remote, tip)
    expect(shadow.commit).toBe(tip)
    expect(shadow.files.map((f) => f.path)).toEqual([
      "AGENTS.md",
      "knowledge/services/a b.md",
      "knowledge/streams/orders.md",
    ])

    await expect(readMarkdownTree(remote, "d".repeat(40))).rejects.toThrow(
      "git fetch failed",
    )
  })
})

it("counts changed foreign files from the run base and pins the old published commit", async () => {
  const work = join(root, "foreign-work")
  await runGit(root, ["init", "--quiet", "-b", "main", work])
  const source = "https://github.com/example/source"
  const file = (name: string, body: string) =>
    `---\nkind: Service\ngenerated_by: ctxpipe\nsource: ${source}\n---\n# ${name}\n\n${body}\n`
  const old = await commit(work, {
    "knowledge/services/api.md": file("API", "Old"),
  })
  const base = await commit(work, {
    "knowledge/services/unrelated.md": file("Unrelated", "Before shadow"),
  })
  const tip = await commit(work, {
    "knowledge/services/api.md": file("API", "Shadow joined"),
  })
  await commit(work, {
    "knowledge/services/later.md": file("Later", "After run"),
  })
  const pair = {
    shadowRunId: "wr_fixture",
    oldRunId: "wr_old",
    status: "completed",
    input: {
      orgId: "org_fixture",
      shadow: true,
      source: {
        kind: "github" as const,
        url: source,
        githubConnectionId: "con_fixture",
      },
      sha: "c".repeat(40),
      authorTime: "2026-10-01T00:00:00.000Z",
    },
    output: {
      status: "done",
      workspaces: [
        {
          workspaceId: "ws_fixture",
          assembled: tip,
          ops: 1,
          rejects: 0,
          partial: 0,
        },
      ],
    },
    shadowStartedAt: null,
    shadowFinishedAt: null,
    oldStartedAt: null,
    oldFinishedAt: null,
  }
  const result = await compareShadowRun({
    pair,
    remoteFor: async () => ({ url: work }),
    revisions: { ws_fixture: { oldPublished: old, shadowBase: base } },
  })
  expect(result.workspaces[0]).toMatchObject({
    oldCommit: old,
    units: { old: 1, shadow: 1, matched: 1, recall: 1 },
  })
  expect(
    await compareShadowRun({ pair, remoteFor: async () => ({ url: work }) }),
  ).toMatchObject({
    status: "incomplete",
    workspaces: [],
    revisionGaps: [
      {
        workspaceId: "ws_fixture",
        field: "oldPublished",
        resolvedByOverride: false,
      },
      {
        workspaceId: "ws_fixture",
        field: "shadowBase",
        resolvedByOverride: false,
      },
    ],
  })
})
