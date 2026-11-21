import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { type SQL, sql } from "drizzle-orm"
import type { BackendPostgres } from "openworkflow/postgres"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"

import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { connectOpenWorkflowBackend } from "./storable-backend.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local"), quiet: true })

const lease = { leaseDurationMs: 30_000 }
const namespaces: string[] = []
const backends: BackendPostgres[] = []

/** A backend in an OpenWorkflow namespace of its own (a new preview name). */
async function connect() {
  const pr = `pr-${Date.now()}${Math.floor(Math.random() * 1000)}`
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", pr)
  namespaces.push(`preview-${pr}`)
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required")
  const backend = await connectOpenWorkflowBackend(url)
  backends.push(backend)
  return backend
}

function createRun(backend: BackendPostgres, workflowName: string) {
  return backend.createWorkflowRun({
    workflowName,
    version: null,
    idempotencyKey: null,
    config: {},
    context: null,
    input: null,
    parentStepAttemptNamespaceId: null,
    parentStepAttemptId: null,
    availableAt: null,
    deadlineAt: null,
  })
}

/**
 * The worker calls of the engine: a parent waits on a child with
 * `step.runWorkflow` and parks, then the child completes, and its completion
 * wakes the parent. Returns the id of the parent.
 */
async function parkParentAndCompleteChild(backend: BackendPostgres) {
  const parentWorker = randomUUID()
  const parent = await createRun(backend, "repository-ingestion-v2")
  expect(
    (await backend.claimWorkflowRun({ workerId: parentWorker, ...lease }))?.id,
  ).toBe(parent.id)
  const wait = await backend.createStepAttempt({
    workflowRunId: parent.id,
    workerId: parentWorker,
    stepName: "repository-skills",
    kind: "workflow",
    config: {},
    context: null,
  })
  const child = await backend.createWorkflowRun({
    workflowName: "ingestion-shard",
    version: null,
    idempotencyKey: null,
    config: {},
    context: null,
    input: null,
    parentStepAttemptNamespaceId: wait.namespaceId,
    parentStepAttemptId: wait.id,
    availableAt: null,
    deadlineAt: null,
  })
  await backend.setStepAttemptChildWorkflowRun({
    workflowRunId: parent.id,
    stepAttemptId: wait.id,
    workerId: parentWorker,
    childWorkflowRunNamespaceId: child.namespaceId,
    childWorkflowRunId: child.id,
  })
  // The wait has no timeout: the parent parks for the default of one year.
  await backend.sleepWorkflowRun({
    workflowRunId: parent.id,
    workerId: parentWorker,
    availableAt: new Date(Date.now() + 365 * 24 * 3600_000),
  })

  const childWorker = randomUUID()
  expect(
    (await backend.claimWorkflowRun({ workerId: childWorker, ...lease }))?.id,
  ).toBe(child.id)
  await backend.completeWorkflowRun({
    workflowRunId: child.id,
    workerId: childWorker,
    output: null,
  })
  return parent.id
}

async function setAvailableAt(id: string, at: SQL) {
  await getSystemDb().execute(sql`
    update openworkflow.workflow_runs set available_at = ${at}
    where namespace_id = ${namespaces.at(-1)} and id = ${id}
  `)
}

beforeAll(() => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required")
  initDb(url)
})

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.stop()))
  vi.unstubAllEnvs()
})

afterAll(async () => {
  for (const namespace of namespaces) {
    await getSystemDb().execute(
      sql`delete from openworkflow.step_attempts where namespace_id = ${namespace}`,
    )
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where namespace_id = ${namespace}`,
    )
  }
  await closeDb()
})

it("claims a woken parent before a run that was queued after the wake (CTX-1478)", async () => {
  const backend = await connect()
  const parent = await parkParentAndCompleteChild(backend)
  // New work arrives all the time while the slots are busy.
  await createRun(backend, "workspace-tip-check")

  const claimed = await backend.claimWorkflowRun({
    workerId: randomUUID(),
    ...lease,
  })

  expect(claimed?.id).toBe(parent)
})

it("claims a run that was queued before the wake before the woken parent", async () => {
  const backend = await connect()
  const earlier = await createRun(backend, "workspace-hydrate")
  // Keep the run out of the claims of the parent flow.
  await setAvailableAt(earlier.id, sql`now() + interval '1 day'`)
  const parent = await parkParentAndCompleteChild(backend)
  // The run waits since before the wake.
  await setAvailableAt(earlier.id, sql`now() - interval '1 minute'`)

  const first = await backend.claimWorkflowRun({
    workerId: randomUUID(),
    ...lease,
  })
  const second = await backend.claimWorkflowRun({
    workerId: randomUUID(),
    ...lease,
  })

  expect([first?.id, second?.id]).toEqual([earlier.id, parent])
})
