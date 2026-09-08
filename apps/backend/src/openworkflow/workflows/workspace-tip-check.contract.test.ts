import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
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
        const queued = await getSystemDb().execute<{
          input: { kind: string; workspaceId: string }
        }>(
          sql`select input from openworkflow.workflow_runs where workflow_name = 'workspace-write-commit' and input->>'workspaceId' = ${f.workspaceId}`,
        )
        expect(
          queued.rows.map((row) => ({
            kind: row.input.kind,
            workspaceId: row.input.workspaceId,
          })),
        ).toEqual([{ kind: "migration_export", workspaceId: f.workspaceId }])
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
        const queued = await getSystemDb().execute<{
          input: { jobId: string; kind: string }
        }>(
          sql`select input from openworkflow.workflow_runs where workflow_name = 'workspace-write-commit' and input->>'jobId' = ${jobId}`,
        )
        expect(
          queued.rows.map((row) => ({
            jobId: row.input.jobId,
            kind: row.input.kind,
          })),
        ).toEqual([{ jobId, kind: "migration_export" }])
      },
    )
  },
)

it(
  "cron records an unknown permission after a writable repository lookup misses",
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
        expect(row).toEqual({ writeStatus: "unknown", readOnlyReason: null })
      },
    )
  },
)
