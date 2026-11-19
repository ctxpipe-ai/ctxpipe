import { sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb } from "../../db/client.js"
import { migrateKnowledgeStore } from "../../knowledge-store/migrate.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { startClickHouse, userUrl } from "../../test/clickhouse.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { knowledgeMaintenance } from "./knowledge-maintenance.js"
import { workspaceFileEdit } from "./workspace-file-edit.js"

/*
 * The knowledge maintenance job (ADR-067 decision 9) with real Git,
 * Postgres and ClickHouse: the hydrate writes the knowledge plane and queues
 * the job, and the job fixes a link through the Workspace write path.
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

const source =
  '# Alpha\n\nSee [the guide](old/guide.md#setup "Guide"), [the copy](gone/copy.md) and [the rate](old/rate%.md). Run [the script](tools/run.sh).\n'
const files = [
  { path: "notes/alpha.md", body: source },
  // The one file named `guide.md`: the link to `old/guide.md` points to it.
  { path: "guides/guide.md", body: "# Guide\n" },
  // Two files named `copy.md`: the job does not choose one.
  { path: "one/copy.md", body: "# One\n" },
  { path: "two/copy.md", body: "# Two\n" },
  // One file named `rate%.md`, but its path needs an escape that the
  // hydrate does not decode.
  { path: "team/rate%.md", body: "# Rate\n" },
  // A file that is not a document: the link to it has a `missing` row, but
  // it is not broken.
  { path: "notes/tools/run.sh", body: "echo run\n" },
  // The front matter does not close, so the file does not parse.
  { path: "broken.md", body: "---\ntitle: Broken\n# Broken\n" },
]

/** The workflow runs of the Workspace with this name. */
async function runs(workflowName: string, workspaceId: string) {
  return (
    await getSystemDb().execute<{
      status: string
      output: unknown
      input: Record<string, unknown>
      error: { message?: string } | null
    }>(
      sql`select status, output, input, error from openworkflow.workflow_runs
        where workflow_name = ${workflowName}
          and input->>'workspaceId' = ${workspaceId}
        order by created_at`,
    )
  ).rows
}

it(
  "reports the failed and missing documents, and rewrites only the link with one match through one write job",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture(
      {
        // The hydrate and the job queue their runs in this namespace.
        namespaceId: openWorkflowNamespaceId(),
        files,
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        knowledgePlane: { clickhouseUrl: writerUrl },
      },
      async (f) => {
        f.runner.implementWorkflow(
          knowledgeMaintenance.spec,
          knowledgeMaintenance.fn,
        )
        // A worker takes the workflows of the runner when it is made.
        const hydrateWorker = f.runner.newWorker({ concurrency: 2 })
        await hydrateWorker.start()
        // The old stack skips the file that does not parse.
        expect(await f.handle.result({ timeoutMs: 120_000 })).toMatchObject({
          hydrated: true,
          skipped: 1,
        })

        // The hydrate queued the job for its tip, and the worker ran it.
        await vi.waitFor(
          async () =>
            expect(
              (await runs("knowledge-maintenance", f.workspaceId)).map(
                (run) => [run.status, run.error?.message ?? null],
              ),
            ).toEqual([["completed", null]]),
          { timeout: 30_000, interval: 100 },
        )
        const [first] = await runs("knowledge-maintenance", f.workspaceId)
        expect(first?.input).toMatchObject({ sha: f.sha })
        // The output of the run is the result of the workflow.
        const report = first?.output as Extract<
          Awaited<ReturnType<typeof knowledgeMaintenance.fn>>,
          { outcome: "checked" }
        >
        expect(report).toMatchObject({
          outcome: "checked",
          counts: { failed: 1, missing: 4, deleted: 0 },
          findingCount: 5,
          rewrittenFiles: 1,
          writeJob: { started: true },
        })
        expect(report.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ status: "failed", path: "broken.md" }),
            expect.objectContaining({
              status: "missing",
              path: "notes/alpha.md",
              target: "notes/old/guide.md",
              matches: 1,
              fixed: true,
            }),
            expect.objectContaining({
              status: "missing",
              path: "notes/alpha.md",
              target: "notes/gone/copy.md",
              matches: 2,
              fixed: false,
            }),
            expect.objectContaining({
              status: "missing",
              path: "notes/alpha.md",
              target: "notes/old/rate%.md",
              matches: 1,
              fixed: false,
            }),
            expect.objectContaining({
              status: "missing",
              path: "notes/alpha.md",
              target: "notes/tools/run.sh",
              matches: 1,
              fixed: false,
            }),
          ]),
        )
        // A finding holds a hash of the document key, not the key.
        expect(JSON.stringify(report.findings)).not.toContain("kn_")

        // A second run of the same tip queues no other job.
        const again = await f.runner.runWorkflow(knowledgeMaintenance.spec, {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          sha: f.sha,
        })
        expect(await again.result({ timeoutMs: 30_000 })).toEqual(report)
        expect(
          (await runs("workspace-write-ui-file-edit", f.workspaceId)).map(
            (run) => run.input.jobId,
          ),
        ).toEqual([report.writeJob?.id])

        // The write path commits the fix.
        await hydrateWorker.stop()
        f.runner.implementWorkflow(workspaceFileEdit.spec, workspaceFileEdit.fn)
        const worker = f.runner.newWorker({ concurrency: 1 })
        await worker.start()
        try {
          await vi.waitFor(
            async () =>
              expect(
                (await runs("workspace-write-ui-file-edit", f.workspaceId)).map(
                  (run) => run.status,
                ),
              ).toEqual(["completed"]),
            { timeout: 60_000, interval: 200 },
          )
        } finally {
          await worker.stop()
        }
        const job = await withOrgIdContext(f.org, () =>
          reconcileWorkspaceWriteJob(report.writeJob?.id ?? ""),
        )
        expect(job).toMatchObject({
          kind: "knowledge_maintenance",
          status: "completed",
        })
        const tip = f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main")
        expect(job?.commitSha).toBe(tip)
        expect(
          f.git(
            "--git-dir",
            f.remote,
            "rev-list",
            "--count",
            `${f.sha}..${tip}`,
          ),
        ).toBe("1")
        expect(
          f.git("--git-dir", f.remote, "show", `${tip}:notes/alpha.md`),
        ).toBe(
          '# Alpha\n\nSee [the guide](../guides/guide.md#setup "Guide"), [the copy](gone/copy.md) and [the rate](old/rate%.md). Run [the script](tools/run.sh).',
        )
        // The job deletes no file.
        expect(
          f.git("--git-dir", f.remote, "show", `${tip}:broken.md`),
        ).toContain("title: Broken")
      },
    ),
)
