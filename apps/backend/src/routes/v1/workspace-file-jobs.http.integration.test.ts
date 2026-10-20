import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { workspaces, workspaceWriteJobs } from "../../db/schema/workspaces.js"
import { persistWriteJobStatus } from "../../models/workspace-write-jobs.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceFilesRoutes } from "./workspace-files-routes.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `org_test_file_jobs_${suffix}`,
  slug: `file-jobs-${suffix}`,
  name: "File jobs",
}
const otherOrg = {
  id: `org_test_file_jobs_other_${suffix}`,
  slug: `file-jobs-other-${suffix}`,
  name: "Other",
}
// Both orgs have a Workspace with the same slug.
const slug = `docs-${suffix}`
const workspace = { id: `ws_file_jobs_${suffix}`, slug }
const sibling = { id: `ws_file_jobs_sibling_${suffix}`, slug: `wiki-${suffix}` }
const otherWorkspace = { id: `ws_file_jobs_other_${suffix}`, slug }
const failedJob = `wjob_failed_${suffix}`
const completedJob = `wjob_completed_${suffix}`
const siblingJob = `wjob_sibling_${suffix}`
const otherJob = `wjob_other_${suffix}`
const bootstrapJob = `wjob_bootstrap_${suffix}`
const endedRunJob = `wjob_ended_run_${suffix}`
const liveRunJob = `wjob_live_run_${suffix}`

/** A run of the file edit workflow that owns `jobId`, as OpenWorkflow stores it. */
async function insertRun(jobId: string, status: string, message?: string) {
  const runId = `run_${jobId}`
  await getSystemDb().execute(sql`
    insert into openworkflow.workflow_runs
      (namespace_id, id, workflow_name, status, config, input, error, attempts, created_at, updated_at)
    values (
      ${openWorkflowNamespaceId()}, ${runId}, 'workspace-write-ui-file-edit', ${status}, '{}'::jsonb,
      ${JSON.stringify({ orgId: org.id, workspaceId: workspace.id, jobId })}::jsonb,
      ${message ? JSON.stringify({ message }) : null}::jsonb, 1, now(), now())`)
  await withOrgDbContext(org.id, (db) =>
    db
      .update(workspaceWriteJobs)
      .set({ payload: { workflowRunId: runId } })
      .where(eq(workspaceWriteJobs.id, jobId)),
  )
}

async function seed(
  target: typeof org,
  row: { id: string; slug: string },
  jobs: Array<{ id: string; kind?: string }>,
) {
  await withOrgDbContext(target.id, async (db) => {
    await db.insert(workspaces).values({
      id: row.id,
      orgId: target.id,
      slug: row.slug,
      displayName: row.slug,
      workspaceRepositoryUrl: `https://github.com/example/${row.slug}.git`,
    })
    for (const job of jobs)
      await db.insert(workspaceWriteJobs).values({
        id: job.id,
        orgId: target.id,
        workspaceId: row.id,
        kind: job.kind ?? "ui_file_edit",
        generation: 1,
        status: "queued",
      })
  })
}

async function readJob(
  target: typeof org,
  jobId: string,
  workspaceSlug = slug,
) {
  const response = await workspaceHttpApp(target, workspaceFilesRoutes).request(
    `/workspaces/${workspaceSlug}/files/jobs/${jobId}`,
  )
  return { status: response.status, body: await response.json() }
}

describe("Files job status route (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    await seed(org, workspace, [
      { id: failedJob },
      { id: completedJob },
      { id: bootstrapJob, kind: "bootstrap" },
      { id: endedRunJob },
      { id: liveRunJob },
    ])
    await seed(org, sibling, [{ id: siblingJob }])
    await seed(otherOrg, otherWorkspace, [{ id: otherJob }])
    // The same model calls that the write workflows make.
    await insertRun(
      endedRunJob,
      "failed",
      "stdout maxBuffer length exceeded\n    at node:child_process:1",
    )
    await insertRun(liveRunJob, "running")
    await withOrgIdContext(org, async () => {
      await persistWriteJobStatus(failedJob, "failed", "superseded")
      await persistWriteJobStatus(completedJob, "completed")
    })
  })

  afterAll(async () => {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where id in (${`run_${endedRunJob}`}, ${`run_${liveRunJob}`})`,
    )
    await withOrgDbContext(org.id, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, org.id)),
    )
    await withOrgDbContext(otherOrg.id, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, otherOrg.id)),
    )
    await closeDb()
  })

  it("returns the reason of a failed job", async () => {
    expect(await readJob(org, failedJob)).toEqual({
      status: 200,
      body: { status: "failed", failureReason: "superseded" },
    })
  })

  it("fails a queued job whose run ended with an error, and gives the cause", async () => {
    const expected = {
      status: 200,
      body: {
        status: "failed",
        failureReason:
          "The write stopped before it finished. stdout maxBuffer length exceeded",
      },
    }
    expect(await readJob(org, endedRunJob)).toEqual(expected)
    // The job stays failed on the next read, with the same reason.
    expect(await readJob(org, endedRunJob)).toEqual(expected)
  })

  it("keeps a queued job whose run still runs", async () => {
    expect(await readJob(org, liveRunJob)).toEqual({
      status: 200,
      body: { status: "queued", failureReason: null },
    })
  })

  it("returns a completed job with no reason", async () => {
    expect(await readJob(org, completedJob)).toEqual({
      status: 200,
      body: { status: "completed", failureReason: null },
    })
  })

  it("does not show a job of another org, also with the same Workspace slug", async () => {
    expect(await readJob(otherOrg, failedJob)).toEqual({
      status: 404,
      body: { error: "Not found" },
    })
    expect(await readJob(org, otherJob)).toEqual({
      status: 404,
      body: { error: "Not found" },
    })
    expect((await readJob(otherOrg, otherJob)).status).toBe(200)
  })

  it("does not show a job of another Workspace or a job that is not a Files edit", async () => {
    expect((await readJob(org, siblingJob)).status).toBe(404)
    expect((await readJob(org, siblingJob, sibling.slug)).status).toBe(200)
    expect((await readJob(org, bootstrapJob)).status).toBe(404)
  })
})
