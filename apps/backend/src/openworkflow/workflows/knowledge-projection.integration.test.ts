import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { initLogger } from "evlog"
import { OpenWorkflow } from "openworkflow"
import type { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { closeDb, getSystemDb, initDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { MAX_CRASHED_STEP_ATTEMPTS } from "../crash-loop.js"
import { connectOpenWorkflowBackend } from "../storable-backend.js"
import {
  knowledgeProjection,
  knowledgeProjectionUnversioned,
} from "./knowledge-projection.js"
import { knowledgePurge, knowledgePurgeUnversioned } from "./knowledge-purge.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

// A PR number of its own gives this file its own OpenWorkflow namespace.
const pr = `pr-${Date.now()}${Math.floor(Math.random() * 1000)}`
const namespace = `preview-${pr}`
const orgId = `org_test_projection_guard_${Date.now()}`
const workspaceId = `ws_test_projection_guard_${Date.now()}`
const STEP = "project-knowledge-plane"

let backend: BackendPostgres
let ow: OpenWorkflow
const events: Record<string, unknown>[] = []

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  initDb(connectionString)
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Projection guard",
    createdAt: new Date(),
  })
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", pr)
  backend = await connectOpenWorkflowBackend(connectionString)
  ow = new OpenWorkflow({ backend })
  ow.implementWorkflow(knowledgeProjection.spec, knowledgeProjection.fn)
  ow.implementWorkflow(
    knowledgeProjectionUnversioned.spec,
    knowledgeProjectionUnversioned.fn,
  )
  ow.implementWorkflow(knowledgePurge.spec, knowledgePurge.fn)
  ow.implementWorkflow(
    knowledgePurgeUnversioned.spec,
    knowledgePurgeUnversioned.fn,
  )
  // The events go to a drain, as in production.
  initLogger({
    env: { service: "ctxpipe-backend-test" },
    pretty: false,
    drain: (ctx) => void events.push(ctx.event as Record<string, unknown>),
  })
})

afterAll(async () => {
  initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
  await getSystemDb().execute(
    sql`delete from openworkflow.step_attempts where namespace_id = ${namespace}`,
  )
  await getSystemDb().execute(
    sql`delete from openworkflow.workflow_runs where namespace_id = ${namespace}`,
  )
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await backend.stop()
  vi.unstubAllEnvs()
  await closeDb()
})

/**
 * The attempts of the projection step that earlier workers left `running`
 * when they stopped in it (out of memory), as OpenWorkflow writes them
 * before the step body runs.
 */
async function crashedAttempts(runId: string, count: number) {
  for (let index = 0; index < count; index++)
    await getSystemDb().execute(sql`
      insert into openworkflow.step_attempts
        (namespace_id, id, workflow_run_id, step_name, kind, status, config,
         started_at, created_at, updated_at)
      values
        (${namespace}, ${`${runId}-crashed-${index}`}, ${runId}, ${STEP},
         'function', 'running', '{}'::jsonb, now(), now(), now())
    `)
}

async function stepAttempts(runId: string) {
  return (await backend.listStepAttempts({ workflowRunId: runId })).data
    .filter((attempt) => attempt.stepName === STEP)
    .map((attempt) => attempt.status)
}

it("fails a projection run whose worker stopped in its step again and again, logs the workflow, and the next run of the Workspace projects (CTX-1616)", async () => {
  const worker = ow.newWorker({ concurrency: 1 })
  try {
    // Queued and stopped: the earlier workers stopped in the step three
    // times before this worker claims the run.
    const looped = await ow.runWorkflow(knowledgeProjection.spec, {
      orgId,
      workspaceId,
    })
    await crashedAttempts(looped.workflowRun.id, MAX_CRASHED_STEP_ATTEMPTS)
    await worker.start()
    // OpenWorkflow gives the error of the run as JSON, so its quotes are
    // escaped.
    await expect(looped.result({ timeoutMs: 30_000 })).rejects.toThrow(
      new RegExp(
        `StepCrashLoopError.*The worker stopped ${MAX_CRASHED_STEP_ATTEMPTS} times during the step \\\\"${STEP}\\\\"`,
      ),
    )
    // The guard ends the step at once: no step retry, no projection.
    expect(await stepAttempts(looped.workflowRun.id)).toEqual([
      ...Array(MAX_CRASHED_STEP_ATTEMPTS).fill("running"),
      "completed",
    ])
    expect(
      events.filter((event) => event.step === "openworkflow.step-crash-loop"),
    ).toEqual([
      expect.objectContaining({
        level: "error",
        workflow: "knowledge-projection",
        workflowRunId: looped.workflowRun.id,
        stepName: STEP,
        crashes: MAX_CRASHED_STEP_ATTEMPTS,
      }),
    ])

    // The next hydrate or push queues a new run, with its own count: its
    // step runs (the Workspace has no row, so it projects nothing).
    const next = await ow.runWorkflow(knowledgeProjection.spec, {
      orgId,
      workspaceId,
    })
    await expect(next.result({ timeoutMs: 30_000 })).resolves.toBeNull()
    expect(await stepAttempts(next.workflowRun.id)).toEqual(["completed"])
  } finally {
    await worker.stop()
  }
}, 120_000)

it.each([
  ["knowledge-projection", knowledgeProjection, knowledgeProjectionUnversioned],
  ["knowledge-purge", knowledgePurge, knowledgePurgeUnversioned],
] as const)(
  "during a rolling deploy, a worker of the version before CTX-1712 gives a %s run of this version back, and a worker of this version runs it and the runs with no version",
  async (_name, workflow, unversionedWorkflow) => {
    // The worker of the earlier version has only the run with no version.
    // Its body stands for the old code: for an org with no flag row, the
    // projection was `off`, and the purge did not wait for the org delete.
    let oldBodyRuns = 0
    const oldRunner = new OpenWorkflow({ backend })
    oldRunner.implementWorkflow({ name: workflow.spec.name }, async () => {
      oldBodyRuns += 1
      return null
    })
    const row = async (id: string) =>
      (
        await getSystemDb().execute<{ status: string; attempts: number }>(
          sql`select status, attempts from openworkflow.workflow_runs where id = ${id}`,
        )
      ).rows[0]
    // The Workspace has no row, so each run of this version ends with no
    // write.
    const input = { orgId, workspaceId }

    // As the new migrate (the backfill) or the new backend (a delete) queues
    // it.
    // One case is the projection, the other the purge: the union of the two
    // specs takes no input type.
    const queued = await ow.runWorkflow(workflow.spec as never, input)
    const oldWorker = oldRunner.newWorker({ concurrency: 1 })
    await oldWorker.start()
    try {
      await vi.waitFor(
        async () =>
          expect((await row(queued.workflowRun.id))?.attempts).toBe(1),
        { timeout: 30_000, interval: 200 },
      )
    } finally {
      await oldWorker.stop()
    }
    expect(oldBodyRuns).toBe(0)
    expect((await row(queued.workflowRun.id))?.status).toBe("pending")

    // An old worker or backend queued a run with no version.
    const unversioned = await ow.runWorkflow(
      unversionedWorkflow.spec as never,
      input,
    )
    await getSystemDb().execute(
      sql`update openworkflow.workflow_runs set available_at = now() where id = ${queued.workflowRun.id}`,
    )
    const worker = ow.newWorker({ concurrency: 1 })
    await worker.start()
    try {
      await expect(queued.result({ timeoutMs: 30_000 })).resolves.toBeNull()
      await expect(
        unversioned.result({ timeoutMs: 30_000 }),
      ).resolves.toBeNull()
    } finally {
      await worker.stop()
    }
    expect(oldBodyRuns).toBe(0)
  },
  120_000,
)
