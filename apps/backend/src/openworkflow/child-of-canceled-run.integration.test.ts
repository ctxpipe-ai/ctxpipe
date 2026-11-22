import { randomUUID } from "node:crypto"

import { sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { connectOpenWorkflowBackend } from "./storable-backend.js"

/*
 * The OpenWorkflow patch of CTX-1507: the worker creates the step attempt of
 * `step.runWorkflow`, and then the child run in a second statement. A cancel
 * of the parent between the two must not leave a child that runs: a cancel
 * of a re-ingestion stops the run tree that it finds, and a later child is
 * not in it. The calls are the calls of the worker, in that order.
 */

const namespace = `test-child-of-canceled-${randomUUID().slice(0, 8)}`
let backend: Awaited<ReturnType<typeof connectOpenWorkflowBackend>>

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required")
  initDb(url)
  backend = await connectOpenWorkflowBackend(url, namespace)
})

afterAll(async () => {
  await backend?.stop()
  await getSystemDb().execute(
    sql`delete from openworkflow.step_attempts where namespace_id = ${namespace}`,
  )
  await getSystemDb().execute(
    sql`delete from openworkflow.workflow_runs where namespace_id = ${namespace}`,
  )
  await closeDb()
})

function createRun(parent?: { namespaceId: string; id: string }) {
  return backend.createWorkflowRun({
    workflowName: parent ? "ingestion-shard" : "repository-ingestion-v2",
    version: null,
    idempotencyKey: null,
    config: {},
    context: null,
    input: null,
    parentStepAttemptNamespaceId: parent?.namespaceId ?? null,
    parentStepAttemptId: parent?.id ?? null,
    availableAt: null,
    deadlineAt: null,
  })
}

/** A claimed parent run, in the step attempt that starts a child run. */
async function parentInChildStep() {
  const workerId = randomUUID()
  const parent = await createRun()
  expect(
    (
      await backend.claimWorkflowRun({
        workerId,
        leaseDurationMs: 30_000,
      })
    )?.id,
  ).toBe(parent.id)
  const step = await backend.createStepAttempt({
    workflowRunId: parent.id,
    workerId,
    stepName: "shard:0",
    kind: "workflow",
    config: {},
    context: null,
  })
  return { parent, step }
}

async function childrenOf(stepAttemptId: string) {
  const result = await getSystemDb().execute<{ id: string }>(sql`
    select id from openworkflow.workflow_runs
    where namespace_id = ${namespace} and parent_step_attempt_id = ${stepAttemptId}
  `)
  return result.rows
}

it("creates the child run of a running parent", async () => {
  const { step } = await parentInChildStep()
  const child = await createRun(step)
  expect(child).toMatchObject({ status: "pending" })
  expect(await childrenOf(step.id)).toEqual([{ id: child.id }])
  // The next test claims the next pending run: it must be its own parent.
  await backend.cancelWorkflowRun({ workflowRunId: child.id })
})

it("creates no child run after a cancel of the parent between its step attempt and the child", async () => {
  const { parent, step } = await parentInChildStep()
  await backend.cancelWorkflowRun({ workflowRunId: parent.id })
  await expect(createRun(step)).rejects.toThrow(/create workflow run/)
  expect(await childrenOf(step.id)).toEqual([])
})
