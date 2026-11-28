import { execFileSync } from "node:child_process"
import { join } from "node:path"

import { sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb } from "../../db/client.js"
import { createKnowledgeStore } from "../../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../../knowledge-store/migrate.js"
import {
  KNOWLEDGE_PROJECTION_WORKFLOW_NAME,
  defaultCaseDuplicates,
  readyKnowledgeHeads,
} from "../../models/knowledge-state.js"
import {
  getWorkspaceById,
  listWorkspaceKnowledgeUnits,
} from "../../models/workspaces.js"
import { workspaceCaseMerge } from "../../openworkflow/workflows/workspace-case-merge.js"
import { workspaceCaseRepair } from "../../openworkflow/workflows/workspace-case-repair.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { workspaceTipCheck } from "../../openworkflow/workflows/workspace-tip-check.js"
import { startClickHouse, userUrl } from "../../test/clickhouse.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"

/*
 * The repair of case duplicates (CTX-1697) against real collaborators: the
 * Workspace repository in Git, Postgres, ClickHouse (the knowledge plane),
 * the write broker and the workflows. msw answers GitHub and the merge
 * model. An outside agent commits copies whose paths differ only in case
 * straight to Git.
 */

let clickhouse: Awaited<ReturnType<typeof startClickHouse>> | undefined
/** The writer user of the worker (ADR-066 decision 9). */
let writerUrl: string

beforeAll(async () => {
  clickhouse = await startClickHouse()
  const adminUrl = await clickhouse.freshDatabase()
  await migrateKnowledgeStore(adminUrl, {
    reader: "reader-test",
    writer: "writer-test",
  })
  writerUrl = userUrl(adminUrl, "ctxpipe_writer", "writer-test")
}, 240_000)

afterAll(async () => {
  await clickhouse?.stop()
})

const billing = "knowledge/services/billing.md"
const billingCopy = "knowledge/services/Billing.md"
const deploy = "knowledge/guides/deploy.md"
const deployCopy = "knowledge/guides/Deploy.md"
const api = "knowledge/apis/payments.md"
const apiCopy = "knowledge/apis/Payments.md"
const merged = "# Billing\n\nThe merged invoice rules.\n"
// A file of a connector mirror that is not Markdown.
const table = "notion/assets/table.csv"
const tableCopy = "notion/assets/Table.csv"

const deployBody = "# Deploy\n\nDeploy [billing](../services/billing.md).\n"
const generated = (text: string) =>
  `---\nkind: API\ngenerated_by: ctxpipe\n---\n\n# Payments\n\n${text}\n`

/**
 * Commit `files` on the default branch of the remote, as an outside agent
 * does: straight to Git, with no write of ctxpipe. A null body deletes the
 * path.
 */
function commitOutside(
  f: NativeHydrationFixture,
  files: Record<string, string | null>,
  parents: string[] = ["refs/heads/main"],
) {
  const index = join(f.remote, "case-test-index")
  const git = (args: string[], input?: string) =>
    execFileSync("git", ["--git-dir", f.remote, ...args], {
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: "Outside agent",
        GIT_AUTHOR_EMAIL: "agent@example.test",
        GIT_COMMITTER_NAME: "Outside agent",
        GIT_COMMITTER_EMAIL: "agent@example.test",
      },
    }).trim()
  git(["read-tree", "refs/heads/main"])
  for (const [path, body] of Object.entries(files)) {
    if (body === null)
      git(["update-index", "--index-info"], `0 ${"0".repeat(40)}\t${path}\n`)
    else
      git([
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${git(["hash-object", "-w", "--stdin"], body)},${path}`,
      ])
  }
  const commit = git([
    "commit-tree",
    git(["write-tree"]),
    ...parents.flatMap((parent) => ["-p", parent]),
    "-m",
    "An outside commit",
  ])
  git(["update-ref", "refs/heads/main", commit])
}

const show = (f: NativeHydrationFixture, ref: string, path: string) =>
  f.git("--git-dir", f.remote, "show", `${ref}:${path}`)

const treePaths = (f: NativeHydrationFixture, ref: string) =>
  f
    .git("--git-dir", f.remote, "ls-tree", "-r", "--name-only", ref)
    .split("\n")
    .filter((path) => path.startsWith("knowledge/"))
    .sort()

/** The runs of the org that a tip check queues, and their follow-ups. */
const followUps = [
  workspaceHydrate.spec.name,
  KNOWLEDGE_PROJECTION_WORKFLOW_NAME,
  workspaceCaseRepair.spec.name,
  workspaceCaseMerge.spec.name,
]

/**
 * Run the tip check, then wait until each run that it queues, and each run
 * that those runs queue, ends. The worker of the fixture runs them in the
 * namespace of the app.
 */
async function tipCheck(f: NativeHydrationFixture) {
  const check = await f.runner.runWorkflow(workspaceTipCheck.spec, {
    orgId: f.org.id,
  })
  await check.result({ timeoutMs: 30_000 })
  const runs = async () =>
    (
      await getSystemDb().execute(
        sql`select workflow_name as "workflowName", status
          from openworkflow.workflow_runs
          where input->>'orgId' = ${f.org.id}
            and workflow_name in (${sql.join(
              followUps.map((name) => sql`${name}`),
              sql`, `,
            )})`,
      )
    ).rows as Array<{ workflowName: string; status: string }>
  await expect
    .poll(
      async () =>
        (await runs()).filter(
          (run) => !["completed", "failed", "canceled"].includes(run.status),
        ).length,
      { timeout: 120_000, interval: 250 },
    )
    .toBe(0)
  return runs()
}

/** The ready head of the default branch on the knowledge plane. */
async function planeHead(f: NativeHydrationFixture) {
  const head = (await readyKnowledgeHeads(f.org.id, [f.workspaceId])).get(
    f.workspaceId,
  )
  if (!head) throw new Error("The knowledge plane has no ready head")
  return head
}

/**
 * The knowledge plane at its head: the paths of the files of its tree, as
 * Git has them, and the paths of the documents that a read shows.
 */
async function plane(f: NativeHydrationFixture) {
  const head = await planeHead(f)
  const store = createKnowledgeStore(writerUrl)
  try {
    const tree = await store.readTree(
      { orgId: f.org.id, workspaceId: f.workspaceId },
      head,
    )
    const pathOf = new Map(tree.map((row) => [row.docKey, row.path]))
    const shown = await store.listDocumentStatuses({
      orgId: f.org.id,
      heads: [{ workspaceId: f.workspaceId, ...head }],
    })
    return {
      files: tree
        .filter((row) => !row.deletedAt && !row.inherit)
        .map((row) => row.path)
        .filter((path) => path.startsWith("knowledge/"))
        .sort(),
      shown: shown
        .filter((row) => row.status === "active")
        .map((row) => pathOf.get(row.docKey) ?? row.docKey)
        .filter((path) => path.startsWith("knowledge/"))
        .sort(),
      caseDuplicates: (await defaultCaseDuplicates(f.org.id)).get(f.workspaceId)
        ?.caseDuplicates,
    }
  } finally {
    await store.close()
  }
}

const unitPaths = (f: NativeHydrationFixture) =>
  withOrgIdContext(f.org, async () =>
    (await listWorkspaceKnowledgeUnits(f.workspaceId)).units
      .map((unit) => unit.path)
      .sort(),
  )

it(
  "repairs the case duplicates of an outside commit on the knowledge plane: the tip check finds them, a direct commit fixes the same content and the ctxpipe files, a pull request with a semantic merge fixes two edited copies, and the plane then holds one path",
  { timeout: 300_000 },
  async () => {
    const pulls: Array<{ head?: string; base?: string; body?: string }> = []
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        knowledgePlane: { clickhouseUrl: writerUrl },
        files: [
          { path: billing, body: "# Billing\n\nThe old invoice rules.\n" },
          { path: deploy, body: deployBody },
          { path: api, body: generated("The lowercase mirror.") },
          { path: table, body: "name,rows\nold,1\n" },
        ],
        // The table is no unit of the old stack.
        units: 3,
        semanticMergeResolution: {
          files: [{ path: billing, content: merged }],
        },
        onGithubPullRequest: (body) => {
          pulls.push(body as (typeof pulls)[number])
        },
      },
      async (f) => {
        f.server.use(
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () => HttpResponse.json([]),
          ),
        )
        await f.publish()

        // An outside agent commits four case duplicates straight to Git.
        commitOutside(f, {
          [billingCopy]: "# Billing\n\nThe new invoice rules.\n",
          [deployCopy]: deployBody,
          [apiCopy]: generated("The mixed-case mirror."),
          [tableCopy]: "name,rows\nnew,2\n",
        })

        // The tip check queues the projection of the new tip. The plane
        // keeps both copies of each path, as Git has them, and a read shows
        // one copy of each file: the copy that Git changed last. The head
        // counts the hidden copies of each file type.
        const projected = await tipCheck(f)
        expect(projected.filter((run) => run.status !== "completed")).toEqual(
          [],
        )
        expect(await plane(f)).toEqual({
          files: [
            api,
            apiCopy,
            billing,
            billingCopy,
            deploy,
            deployCopy,
          ].sort(),
          shown: [apiCopy, billingCopy, deployCopy].sort(),
          caseDuplicates: 4,
        })
        // The old stack shows the same copies.
        expect(await unitPaths(f)).toEqual(
          [apiCopy, deployCopy, billingCopy].sort(),
        )

        // The tip check finds the hidden copies on the plane and queues the
        // repair.
        const repaired = await tipCheck(f)
        expect(repaired.filter((run) => run.status !== "completed")).toEqual([])
        // The direct commit keeps the lowercase path of the same content
        // and of the ctxpipe file, with the text of the copy that the reads
        // show. The edited copies stay on the default branch until a person
        // merges the pull request.
        expect(treePaths(f, "refs/heads/main")).toEqual(
          [api, deploy, billing, billingCopy].sort(),
        )
        expect(show(f, "refs/heads/main", api)).toBe(
          generated("The mixed-case mirror.").trimEnd(),
        )
        // The copy of a file that is not Markdown that Git changed last.
        expect(
          f.git(
            "--git-dir",
            f.remote,
            "ls-tree",
            "--name-only",
            "refs/heads/main",
            "notion/assets/",
          ),
        ).toBe(table)
        expect(show(f, "refs/heads/main", table)).toBe("name,rows\nnew,2")
        // The pull request merges the edited copies into the lowercase
        // path, and deletes the other copy.
        expect(pulls).toHaveLength(1)
        const branch = pulls[0]?.head ?? ""
        expect(branch).toMatch(/^ctxpipe\/case-duplicates-/)
        expect(pulls[0]?.base).toBe("main")
        expect(treePaths(f, `refs/heads/${branch}`)).toContain(billing)
        expect(treePaths(f, `refs/heads/${branch}`)).not.toContain(billingCopy)
        expect(show(f, `refs/heads/${branch}`, billing)).toBe(merged.trimEnd())
        // The tip of the direct commit is on the plane, with one hidden copy.
        await tipCheck(f)
        expect(await plane(f)).toEqual({
          files: [api, billing, billingCopy, deploy].sort(),
          shown: [api, billingCopy, deploy].sort(),
          caseDuplicates: 1,
        })

        // A person merges the pull request.
        commitOutside(f, { [billing]: merged, [billingCopy]: null }, [
          "refs/heads/main",
          `refs/heads/${branch}`,
        ])
        await tipCheck(f)
        // The plane holds one path of each file, and no copy is hidden.
        expect(await plane(f)).toEqual({
          files: [api, billing, deploy].sort(),
          shown: [api, billing, deploy].sort(),
          caseDuplicates: 0,
        })
        expect(await unitPaths(f)).toEqual([api, deploy, billing].sort())
        expect(
          (await withOrgIdContext(f.org, () => getWorkspaceById(f.workspaceId)))
            ?.hydratePhases?.skipped ?? [],
        ).toEqual([])
      },
    )
  },
)
