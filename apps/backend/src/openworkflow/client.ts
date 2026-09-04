import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import {
  DB_STARTUP_CONNECTION_RETRY,
  waitForDbConnection,
} from "../db/transientDbRetry.js"
import { openWorkflowNamespaceId } from "./namespace.js"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for OpenWorkflow client")
await waitForDbConnection(databaseUrl, DB_STARTUP_CONNECTION_RETRY)
const backend = await BackendPostgres.connect(databaseUrl, {
  namespaceId: openWorkflowNamespaceId(),
})
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
