import { parseOpenWorkflowConcurrency } from "./codesearchCapacity.js"

/**
 * The ingestion shards that run in this worker process now. A shard holds
 * its worker slot for its whole run, also while its sandbox works.
 */
let running = 0

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
 * Run the execution `fn` of a shard in the worker share. When the share is
 * full, the shard parks (`step.sleep`), so it frees its worker slot, and
 * tries again: after 15 seconds, then up to 5 minutes. A replay finds its
 * finished waits, so it waits again only when the share is full again.
 */
export async function withIngestWorkerShare<T>(
  step: { sleep(name: string, duration: `${number} seconds`): Promise<void> },
  fn: () => Promise<T>,
  share = ingestWorkerShare(),
): Promise<T> {
  for (let wait = 0; running >= share; wait++)
    await step.sleep(
      `await-worker-share:${wait}`,
      `${Math.min(300, 15 * 2 ** Math.min(wait, 5))} seconds`,
    )
  running++
  try {
    return await fn()
  } finally {
    running--
  }
}
