import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceWriteJobs } from "../../db/schema/workspaces.js"
import { persistBoundWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

// ctxpipe does not write `valid_from` into Workspace files any more
// (CTX-1710). A job that an earlier release planned ends with no commit.

async function jobStatus(orgId: string, jobId: string) {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({
        status: workspaceWriteJobs.status,
        reason: sql<
          string | null
        >`${workspaceWriteJobs.payload}->>'failureReason'`,
      })
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, jobId)),
  )
  return row
}

it(
  "refuses an old valid_from_persist job at admission and completes it, so no resume admits it again",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.handle.cancel()
        const jobId = `wjob_${f.id}_dates`
        const revision = {
          ...(await f.resolveRevision()),
          access: "write-default" as const,
        }
        await withOrgIdContext(f.org, () =>
          persistBoundWriteJob({
            admissionStatus: "paused",
            id: jobId,
            kind: "valid_from_persist",
            revision,
          }),
        )
        const errors: Error[] = []
        expect(
          await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                jobId,
                kind: "valid_from_persist",
              },
              { error: (error) => errors.push(error) },
            ),
          ),
        ).toEqual({ started: false })
        expect(errors.map((error) => error.message)).toEqual([
          "ctxpipe does not write valid_from into Workspace files any more. Admission refuses the valid_from_persist write.",
        ])
        expect(await jobStatus(f.org.id, jobId)).toEqual({
          status: "completed",
          reason: expect.stringContaining("does not write valid_from"),
        })
        expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
      },
    )
  },
)

it(
  "ends a queued valid_from_persist run of an earlier release with no write",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.handle.cancel()
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { workspaceValidFromPersistRetired } =
          await import("../../openworkflow/workflows/workspace-valid-from-persist.js")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(
          workspaceValidFromPersistRetired.spec,
          workspaceValidFromPersistRetired.fn,
        )
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const jobId = `wjob_${f.id}_queued_dates`
          const revision = {
            ...(await f.resolveRevision()),
            access: "write-default" as const,
          }
          await withOrgIdContext(f.org, () =>
            persistBoundWriteJob({
              id: jobId,
              kind: "valid_from_persist",
              revision,
            }),
          )
          // Raw input, as a queued run of an earlier release holds it.
          const run = await runner.runWorkflow(
            workspaceValidFromPersistRetired.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId,
              revision,
            },
          )
          expect(await run.result({ timeoutMs: 30_000 })).toEqual({
            status: "retired",
          })
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
          expect(await jobStatus(f.org.id, jobId)).toEqual({
            status: "completed",
            reason: expect.stringContaining("does not write valid_from"),
          })
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)
