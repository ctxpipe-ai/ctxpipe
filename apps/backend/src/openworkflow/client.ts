import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required for OpenWorkflow client")
const backend = await BackendPostgres.connect(databaseUrl)
export const ow = new OpenWorkflow({ backend })

/** Prefer this over `ow.runWorkflow` so PR workers are woken on Railway after enqueue. */
export function runWorkflowWithWorkerWake(
  ...args: Parameters<typeof ow.runWorkflow>
): ReturnType<typeof ow.runWorkflow> {
  const p = ow.runWorkflow(...args)
  void p.then(() => {
    scheduleEnsureWorkerRunning()
  })
  return p
}
