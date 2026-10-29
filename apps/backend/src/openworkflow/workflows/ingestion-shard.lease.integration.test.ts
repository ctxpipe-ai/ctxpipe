import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { OpenWorkflow } from "openworkflow"
import type { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { z } from "zod"

import { closeDb, getSystemDb, initDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import type { IngestShardRuntime } from "../../domain/ingestion/ingest-shard-runtime.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { openWorkflowExecution } from "../execution-lease.js"
import { connectOpenWorkflowBackend } from "../storable-backend.js"
import {
  guardedSkillStep,
  type IngestionShardWorkspace,
  runSkillPages,
} from "./ingestion-shard.js"

/*
 * A shard child whose OpenWorkflow lease another execution took (CTX-1080).
 * The worker is a real OpenWorkflow worker on Postgres. The test takes the
 * run as a second worker claim does: it sets another `worker_id` and adds
 * one to `attempts`.
 */

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

// A PR number of its own gives this file its own OpenWorkflow namespace.
const pr = `pr-${Date.now()}${Math.floor(Math.random() * 1000)}`
const namespace = `preview-${pr}`
const orgId = `org_lease_${pr}`
const workspaceId = "ws_lease"
const once = { maximumAttempts: 1 }

let backend: BackendPostgres
let ow: OpenWorkflow

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  initDb(connectionString)
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", pr)
  backend = await connectOpenWorkflowBackend(connectionString)
  ow = new OpenWorkflow({ backend })
  await getSystemDb()
    .insert(organizations)
    .values({ id: orgId, name: "Lease", slug: orgId, createdAt: new Date() })
})

afterAll(async () => {
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

/** A second claim of the run, as when the lease ran out (CTX-1009). */
async function anotherExecutionTakes(runId: string) {
  await getSystemDb().execute(sql`
    update openworkflow.workflow_runs
    set worker_id = 'worker-of-the-other-execution',
      attempts = attempts + 1,
      available_at = now() + interval '10 minutes'
    where namespace_id = ${namespace} and id = ${runId}
  `)
}

async function runRow(runId: string) {
  const rows = await getSystemDb().execute<{
    worker_id: string | null
    attempts: number
  }>(sql`
    select worker_id, attempts from openworkflow.workflow_runs
    where namespace_id = ${namespace} and id = ${runId}
  `)
  return rows.rows[0]
}

async function stepStatuses(runId: string) {
  const rows = await getSystemDb().execute<{ status: string }>(sql`
    select status from openworkflow.step_attempts
    where namespace_id = ${namespace} and workflow_run_id = ${runId}
    order by created_at
  `)
  return rows.rows.map((row) => row.status)
}

it(
  "makes no model call after another execution took the run",
  { timeout: 60_000 },
  async () => {
    const calls: number[] = []
    let runId = ""
    const runtime = {
      runStep: async () => {
        calls.push(calls.length + 1)
        // The worker stalled during the first attempt; another execution
        // took the run, and the attempt failed (for example, the sandbox
        // lock went to the other execution).
        if (calls.length === 1) await anotherExecutionTakes(runId)
        throw new Error("Sandbox lock ownership expired")
      },
    } as unknown as IngestShardRuntime
    const workflow = defineWorkflow(
      { name: `ingest-lease-${pr}`, schema: z.object({}), retryPolicy: once },
      async ({ step, run }) => {
        runId = run.id
        const state: IngestionShardWorkspace = {
          workspaceId,
          tip: null,
          ops: 0,
          rejects: 0,
          partial: 0,
          partialRoots: [],
        }
        await runSkillPages({
          step: guardedSkillStep(step, run.id, orgId),
          execution: openWorkflowExecution(step, run.id),
          run: { runId: "run_lease", shard: 0, roots: [] } as never,
          // The other execution has not pushed: the ref has no commit.
          broker: { find: async () => null } as never,
          runtime,
          root: null,
          skill: { name: "apis", run: "model" } as never,
          destination: {
            workspaceId,
            pinnedRevision: "0".repeat(40),
          } as never,
          ref: "refs/ctxpipe/ingest/lease",
          runBase: "0".repeat(40),
          state,
        })
        return state
      },
    )
    ow.implementWorkflow(workflow.spec, workflow.fn)
    const handle = await ow.runWorkflow(workflow.spec, {})
    const worker = ow.newWorker({ concurrency: 1 })
    await worker.start()
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), {
      timeout: 15_000,
    })
    // `stop` waits until the execution of this worker ends.
    await worker.stop()

    expect(calls).toEqual([1])
    // The other execution owns the run. OpenWorkflow refused the outcome of
    // the stale execution's step, so the attempt stays `running`.
    expect(await runRow(handle.workflowRun.id)).toEqual({
      worker_id: "worker-of-the-other-execution",
      attempts: 2,
    })
    expect(await stepStatuses(handle.workflowRun.id)).toEqual(["running"])
  },
)
