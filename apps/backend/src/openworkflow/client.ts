import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import postgres from "postgres"
import { attachJobTelemetryForSchema } from "../observability/jobTelemetry.js"
import { openWorkflowNamespaceId } from "./namespace.js"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for OpenWorkflow client")
const namespaceId = openWorkflowNamespaceId()
const backend = await BackendPostgres.connect(databaseUrl, {
  runMigrations: false,
  namespaceId,
})
export const ow = new OpenWorkflow({ backend })
// One connection for the idempotency lookup in `runWorkflowWithWorkerWake`.
const runLookup = postgres(databaseUrl, { max: 1 })

export async function closeOpenWorkflowClient(): Promise<void> {
  await Promise.all([backend.stop(), runLookup.end()])
}

function assertNativeWorkflowVersion(
  spec: Parameters<typeof ow.runWorkflow>[0],
  handle: Awaited<ReturnType<typeof ow.runWorkflow>>,
): Awaited<ReturnType<typeof ow.runWorkflow>> {
  // Native idempotency is name/key scoped and can return a prior version.
  if (
    handle.workflowRun.workflowName !== spec.name ||
    handle.workflowRun.version !== (spec.version ?? null)
  )
    throw new Error(
      "Native workflow key belongs to a different workflow version",
    )
  return handle
}

/** Prefer this over `ow.runWorkflow` so PR workers are woken on Railway after enqueue. */
export async function runWorkflowWithWorkerWake(
  ...args: Parameters<typeof ow.runWorkflow>
): ReturnType<typeof ow.runWorkflow> {
  const [spec, input, options] = args
  // A repeated idempotency key returns the earlier run, and that run already
  // woke the worker. Wake the worker only for a new run.
  const existed =
    options?.idempotencyKey != null &&
    (await idempotentRunExists(spec.name, options.idempotencyKey))
  const handle = assertNativeWorkflowVersion(
    spec,
    await ow.runWorkflow(
      spec,
      attachJobTelemetryForSchema(spec.schema, input) as typeof input,
      options,
    ),
  )
  if (!existed) scheduleEnsureWorkerRunning()
  return handle
}

/** The same lookup window as OpenWorkflow idempotency (24 hours). */
async function idempotentRunExists(
  workflowName: string,
  idempotencyKey: string,
): Promise<boolean> {
  const rows =
    await runLookup`select 1 from openworkflow.workflow_runs where namespace_id = ${namespaceId} and workflow_name = ${workflowName} and idempotency_key = ${idempotencyKey} and created_at >= now() - interval '24 hours' limit 1`
  return rows.length > 0
}
