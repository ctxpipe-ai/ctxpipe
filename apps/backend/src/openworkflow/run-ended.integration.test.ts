import { randomUUID } from "node:crypto"

import { sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { openWorkflowNamespaceId } from "./namespace.js"
import { whileWorkflowRunActive } from "./run-ended.js"
import { connectOpenWorkflowBackend } from "./storable-backend.js"

/*
 * The fence of an effect that must not happen after a cancel (CTX-1507),
 * with a real OpenWorkflow backend: the publish of an ingestion run pushes
 * through it.
 */

let backend: Awaited<ReturnType<typeof connectOpenWorkflowBackend>>
const runs: string[] = []

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required")
  initDb(url)
  backend = await connectOpenWorkflowBackend(url)
})

afterAll(async () => {
  await backend?.stop()
  for (const id of runs)
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where namespace_id = ${openWorkflowNamespaceId()} and id = ${id}`,
    )
  await closeDb()
})

/** A run that no worker claims. */
async function pendingRun() {
  const run = await backend.createWorkflowRun({
    workflowName: `test-fence-${randomUUID()}`,
    version: null,
    idempotencyKey: null,
    config: {},
    context: null,
    input: null,
    parentStepAttemptNamespaceId: null,
    parentStepAttemptId: null,
    availableAt: new Date(Date.now() + 3_600_000),
    deadlineAt: null,
  })
  runs.push(run.id)
  return run.id
}

it("does not run the effect of a canceled run", async () => {
  const runId = await pendingRun()
  await backend.cancelWorkflowRun({ workflowRunId: runId })
  let ran = false
  await expect(
    whileWorkflowRunActive(runId, async () => {
      ran = true
    }),
  ).rejects.toThrow(/ended before the effect/)
  expect(ran).toBe(false)
})

it("holds a cancel that comes during the effect until the effect ends", async () => {
  const runId = await pendingRun()
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const order: string[] = []
  let started: () => void = () => undefined
  const effectStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const fenced = whileWorkflowRunActive(runId, async () => {
    started()
    await held
    order.push("effect")
  })
  await effectStarted
  const cancel = backend
    .cancelWorkflowRun({ workflowRunId: runId })
    .then(() => order.push("cancel"))
  // The update of the cancel waits for the lock that the effect holds.
  await expect
    .poll(async () => {
      const waits = await getSystemDb().execute<{ count: string }>(sql`
        select count(*) from pg_stat_activity
        where wait_event_type = 'Lock'
          and query like '%"status" = ''canceled''%'
          and query like '%workflow_runs%'
      `)
      return Number(waits.rows[0]?.count)
    })
    .toBeGreaterThan(0)
  expect(order).toEqual([])
  release()
  await fenced
  await cancel
  expect(order).toEqual(["effect", "cancel"])
})
