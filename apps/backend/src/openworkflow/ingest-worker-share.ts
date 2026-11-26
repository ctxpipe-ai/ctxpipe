import type { BackendPostgres } from "openworkflow/postgres"

import { INGESTION_SHARD_WORKFLOW_NAME } from "../domain/ingestion/ingestion-run.js"
import { parseOpenWorkflowConcurrency } from "./codesearchCapacity.js"

/**
 * The worker slots of this process that ingestion shards can use: half of
 * its OpenWorkflow concurrency (ADR-027), at least 1. Each worker gets its
 * part of the cluster budget, so all shards of the deployment use at most
 * half of that budget, and the other workflows (for example the webhook
 * syncs) always keep the other half (ADR-052, revision 2026-11-25). This
 * cap protects the worker capacity, not a model provider. It goes when a
 * shard stops holding its worker slot.
 */
export function ingestWorkerShare(
  env: Record<string, string | undefined> = process.env,
): number {
  return Math.max(
    1,
    Math.floor(parseOpenWorkflowConcurrency(env.OPENWORKFLOW_CONCURRENCY) / 2),
  )
}

/**
 * Keep the ingestion shards of this worker process in its worker share.
 * While the slots of the process run `share` shards, a claim of the process
 * does not take a shard run (the claim counts them in the OpenWorkflow runs
 * table, with a live lease). A shard that has no place stays in the queue: `WorkerQueueDepth`
 * counts it, so the worker scales out. The claim order gives a free place
 * in any worker process to a shard of the org that runs the fewest runs
 * (CTX-1707), and in that org to the shard that waits longest (CTX-1634).
 * The claims of one process run one at a time, so
 * the claims of one poll cannot take more places than are free.
 */
export function limitIngestShardClaims(backend: BackendPostgres): void {
  const share = ingestWorkerShare()
  const claim = backend.claimWorkflowRun.bind(backend)
  // OpenWorkflow gives each slot of a worker one fixed id.
  const slots = new Set<string>()
  let previous: Promise<unknown> = Promise.resolve()
  backend.claimWorkflowRun = (params) => {
    slots.add(params.workerId)
    const claimed = previous.then(() =>
      claim({
        ...params,
        workflowSlotLimit: {
          workflowName: INGESTION_SHARD_WORKFLOW_NAME,
          workerIds: [...slots],
          max: share,
        },
      }),
    )
    previous = claimed.catch(() => undefined)
    return claimed
  }
}
