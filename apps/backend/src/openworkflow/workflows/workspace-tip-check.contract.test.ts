import { eq } from "drizzle-orm"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces, workspaceWriteJobs } from "../../db/schema/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { workspaceTipCheck } from "./workspace-tip-check.js"

it(
  "cron queues a missing migration export through real OpenWorkflow outside SQL",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const handle = await f.runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: f.org.id,
        })
        expect(await handle.result({ timeoutMs: 30_000 })).toEqual({
          updated: 0,
          linkedUpdated: 0,
        })
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        try {
          const queued = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) =>
              (run.input as { workspaceId?: string })?.workspaceId ===
                f.workspaceId &&
              run.workflowName === "workspace-write-migration-export",
          )
          expect(queued).toEqual([
            expect.objectContaining({
              workflowName: "workspace-write-migration-export",
              input: expect.objectContaining({
                workspaceId: f.workspaceId,
                revision: expect.objectContaining({
                  sha: f.sha,
                  access: "write-default",
                }),
              }),
            }),
          ])
        } finally {
          await backend.stop()
        }
      },
    )
  },
)

it(
  "cron resumes a paused write job through the native workflow queue",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const jobId = `wjob_${f.id}`
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(workspaceWriteJobs).values({
            id: jobId,
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            kind: "migration_export",
            generation: 1,
            desiredSha: f.sha,
            status: "paused",
            payload: { jobWorkspaceUrl: f.workspaceUrl },
          }),
        )
        const handle = await f.runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: f.org.id,
        })
        await handle.result({ timeoutMs: 30_000 })
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        try {
          const queued = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) => (run.input as { jobId?: string })?.jobId === jobId,
          )
          expect(queued).toEqual([
            expect.objectContaining({
              workflowName: "workspace-write-migration-export",
              input: expect.objectContaining({
                jobId,
                revision: expect.objectContaining({
                  sha: f.sha,
                  access: "write-default",
                }),
              }),
            }),
          ])
        } finally {
          await backend.stop()
        }
      },
    )
  },
)

it(
  "cron records read-only access after the repository leaves its installation",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "missing", writeStatus: "writable" },
      async (f) => {
        await f.publish()
        const handle = await f.runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: f.org.id,
        })
        await handle.result({ timeoutMs: 30_000 })
        const [row] = await withOrgDbContext(f.org.id, (db) =>
          db
            .select({
              writeStatus: workspaces.writeStatus,
              readOnlyReason: workspaces.readOnlyReason,
            })
            .from(workspaces)
            .where(eq(workspaces.id, f.workspaceId)),
        )
        expect(row).toEqual({
          writeStatus: "read_only",
          readOnlyReason:
            "This repository is not in the GitHub App installation. An installation owner or admin must add it, then refresh.",
        })
      },
    )
  },
)
