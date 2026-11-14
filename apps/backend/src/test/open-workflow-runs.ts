import { BackendPostgres } from "openworkflow/postgres"
import postgres from "postgres"

import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"

/**
 * Cancels the open runs of one OpenWorkflow namespace and returns their ids.
 * Each test file has its own namespace, so its open runs cannot slow the
 * workers of another file. Each run is canceled through OpenWorkflow, so a
 * parent run that waits on it wakes.
 */
export async function cancelOpenWorkflowRuns(
  databaseUrl: string,
  namespaceId: string,
): Promise<string[]> {
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 2,
    onnotice: () => undefined,
  })
  const ids = await sql<{ id: string }[]>`
      select id from openworkflow.workflow_runs
      where namespace_id = ${namespaceId}
        and status in ('pending', 'running', 'sleeping')
    `
    .then((rows) => rows.map((row) => row.id))
    .finally(() => sql.end())
  if (ids.length === 0) return []
  const backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId,
  })
  try {
    for (const id of ids) await cancelWorkflowRunIfOpen(backend, id)
    return ids
  } finally {
    await backend.stop()
  }
}

/**
 * Cancels one run, and wakes its parent run. A worker can end the run after
 * the caller read its status and before the cancel. OpenWorkflow then throws
 * "Cannot cancel workflow run … with status completed". A run that has ended
 * needs no cancel, so this function ignores that error. Other errors stay.
 */
export async function cancelWorkflowRunIfOpen(
  backend: Pick<BackendPostgres, "cancelWorkflowRun" | "getWorkflowRun">,
  workflowRunId: string,
): Promise<void> {
  try {
    await backend.cancelWorkflowRun({ workflowRunId })
  } catch (error) {
    const run = await backend.getWorkflowRun({ workflowRunId })
    if (run && ["completed", "failed", "canceled"].includes(run.status)) return
    throw error
  }
}

type QueuedWorkflowRun = {
  workflowName: string
  input: unknown
  idempotencyKey: string | null
}

/**
 * Returns the runs that this test file queued, oldest first, and deletes
 * them. The runs are in the namespace of the file (see
 * `setup-openworkflow-runs.ts`). Call it before each test. Then each test
 * reads only its own runs, and an idempotency key of an earlier test does
 * not return the run of that test.
 */
export async function takeQueuedWorkflowRuns(): Promise<QueuedWorkflowRun[]> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined })
  try {
    return await sql<QueuedWorkflowRun[]>`
      with taken as (
        delete from openworkflow.workflow_runs
        where namespace_id = ${openWorkflowNamespaceId()}
        returning workflow_name, input, idempotency_key, created_at
      )
      select workflow_name as "workflowName", input,
        idempotency_key as "idempotencyKey"
      from taken order by created_at
    `
  } finally {
    await sql.end()
  }
}

/**
 * Queues a run of another version of the workflow under the idempotency key.
 * `enqueueWorkflow` then refuses that key, so a test can make an enqueue fail
 * through the real queue.
 */
export async function queueRunOfOtherVersion(
  workflowName: string,
  idempotencyKey: string,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  const backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
  try {
    await backend.createWorkflowRun({
      workflowName,
      version: "other-version",
      idempotencyKey,
      config: {},
      context: null,
      input: null,
      parentStepAttemptNamespaceId: null,
      parentStepAttemptId: null,
      availableAt: null,
      deadlineAt: null,
    })
  } finally {
    await backend.stop()
  }
}
