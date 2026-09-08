import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for OpenWorkflow client")
const backend = await BackendPostgres.connect(databaseUrl, {
  runMigrations: false,
})
export const ow = new OpenWorkflow({ backend })

/** Prefer this over `ow.runWorkflow` so PR workers are woken on Railway after enqueue. */
export const runWorkflowWithWorkerWake: typeof ow.runWorkflow = (...args) => {
  const p = ow.runWorkflow(...args).then((handle) => {
    // Native idempotency is name/key scoped and can return a prior version.
    if (
      handle.workflowRun.workflowName !== args[0].name ||
      handle.workflowRun.version !== (args[0].version ?? null)
    )
      throw new Error(
        "Native workflow key belongs to a different workflow version",
      )
    return handle
  })
  void p.then(
    () => scheduleEnsureWorkerRunning(),
    // The caller observes the original enqueue rejection through p.
    () => undefined,
  )
  return p
}
