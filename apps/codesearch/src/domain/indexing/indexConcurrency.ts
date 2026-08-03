import { randomUUID } from "node:crypto"
import { tryEmitIndexEvent } from "../../observability/indexingLog.js"

/**
 * Limits how many repository index pipelines run at once on this codesearch
 * instance. Zoekt + SCIP indexing are memory-heavy; parallel runs on large repos
 * (e.g. kubernetes, llvm) can OOM the container even without persistent watchers.
 *
 * Phased OpenWorkflow indexing holds one lease across clone→zoekt→scip→merge
 * via {@link beginIndexLease} / {@link endIndexLease}. Legacy `POST /index`
 * still uses {@link withIndexConcurrency}.
 */
const MAX_CONCURRENT_INDEX_RUNS = 1

let activeIndexRuns = 0
const indexWaiters: Array<() => void> = []
const activeLeases = new Set<string>()

function releaseIndexSlot(): void {
  activeIndexRuns = Math.max(0, activeIndexRuns - 1)
  const next = indexWaiters.shift()
  if (next) next()
}

async function acquireIndexSlot(): Promise<void> {
  if (activeIndexRuns < MAX_CONCURRENT_INDEX_RUNS) {
    activeIndexRuns += 1
    return
  }
  await new Promise<void>((resolve) => {
    indexWaiters.push(() => {
      activeIndexRuns += 1
      resolve()
    })
  })
}

export async function withIndexConcurrency<T>(
  fn: () => Promise<T>,
  onWaiting?: () => void | Promise<void>,
): Promise<T> {
  const waiting = activeIndexRuns >= MAX_CONCURRENT_INDEX_RUNS
  if (waiting) {
    tryEmitIndexEvent("codesearch.index.queue.wait")
    await onWaiting?.()
  }
  await acquireIndexSlot()
  tryEmitIndexEvent("codesearch.index.queue.acquired")
  try {
    return await fn()
  } finally {
    releaseIndexSlot()
    tryEmitIndexEvent("codesearch.index.queue.released")
  }
}

/**
 * Acquire a durable index lease for phased indexing. Call {@link endIndexLease}
 * with the returned id when the pipeline finishes (success or failure).
 * Idempotent end: releasing an unknown/already-ended lease is a no-op.
 */
export async function beginIndexLease(
  onWaiting?: () => void | Promise<void>,
): Promise<{ leaseId: string }> {
  const waiting = activeIndexRuns >= MAX_CONCURRENT_INDEX_RUNS
  if (waiting) {
    tryEmitIndexEvent("codesearch.index.queue.wait")
    await onWaiting?.()
  }
  await acquireIndexSlot()
  const leaseId = randomUUID()
  activeLeases.add(leaseId)
  tryEmitIndexEvent("codesearch.index.queue.acquired", { leaseId })
  return { leaseId }
}

export async function endIndexLease(leaseId: string): Promise<void> {
  if (!activeLeases.has(leaseId)) return
  activeLeases.delete(leaseId)
  releaseIndexSlot()
  tryEmitIndexEvent("codesearch.index.queue.released", { leaseId })
}
