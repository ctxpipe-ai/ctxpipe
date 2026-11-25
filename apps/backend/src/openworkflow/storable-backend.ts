import { BackendPostgres } from "openworkflow/postgres"

import { storable } from "../db/storable.js"
import { getLogger, log } from "../observability/logger.js"
import { claimInIngestWorkerShare } from "./ingest-worker-share.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/**
 * Connect the OpenWorkflow backend of the app and the worker. A step or a
 * workflow can fail with, or return, text that Postgres refuses (for example
 * a file that holds a NUL byte). Without this, the write of the outcome
 * fails and hides the real error.
 */
export async function connectOpenWorkflowBackend(
  databaseUrl: string,
  /** A test gives its own namespace, so that no other worker claims its runs. */
  namespaceId = openWorkflowNamespaceId(),
): Promise<BackendPostgres> {
  const backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId,
  })
  const completeStep = backend.completeStepAttempt.bind(backend)
  const failStep = backend.failStepAttempt.bind(backend)
  const completeRun = backend.completeWorkflowRun.bind(backend)
  const failRun = backend.failWorkflowRun.bind(backend)
  const rescheduleRun =
    backend.rescheduleWorkflowRunAfterFailedStepAttempt.bind(backend)
  backend.completeStepAttempt = async (params) => {
    const text = JSON.stringify(params.output)
    const attempt = await completeStep({
      ...params,
      output: storable(params.output, text),
    })
    // OpenWorkflow reads each step output of a run again from Postgres on
    // each claim. A large output costs memory and Postgres traffic on each
    // replay (CTX-955), so name each one. The warning never changes the
    // step result.
    try {
      const bytes = text === undefined ? 0 : Buffer.byteLength(text)
      if (bytes > 2 ** 20)
        getLogger().warn("openworkflow.step_output_large", {
          workflowRunId: params.workflowRunId,
          stepName: attempt.stepName,
          bytes,
        })
    } catch {
      // A failed warning is not a failed step.
    }
    return attempt
  }
  // OpenWorkflow writes a failed heartbeat only to `console.error`. A failed
  // extension usually means that another execution took the run (CTX-1080),
  // so the log names the run and the worker id of the stale execution. The
  // heartbeat runs outside the workflow logger, so this uses `log`.
  const extendLease = backend.extendWorkflowRunLease.bind(backend)
  backend.extendWorkflowRunLease = async (params) => {
    try {
      return await extendLease(params)
    } catch (error) {
      try {
        log.warn({
          step: "openworkflow.lease_extend_failed",
          message:
            "The worker could not extend the lease of the workflow run; another execution can own the run",
          workflowRunId: params.workflowRunId,
          workerId: params.workerId,
          errorClass: error instanceof Error ? error.name : typeof error,
        })
      } catch {
        // A failed warning must not replace the error of the extension.
      }
      throw error
    }
  }
  backend.failStepAttempt = (params) =>
    failStep({ ...params, error: storable(params.error) })
  backend.completeWorkflowRun = (params) =>
    completeRun({ ...params, output: storable(params.output) })
  backend.failWorkflowRun = (params) =>
    failRun({ ...params, error: storable(params.error) })
  backend.rescheduleWorkflowRunAfterFailedStepAttempt = (params) =>
    rescheduleRun({ ...params, error: storable(params.error) })
  // The ingestion shards use at most half of the worker slots (ADR-052,
  // revision 2026-11-25).
  claimInIngestWorkerShare(backend)
  return backend
}
