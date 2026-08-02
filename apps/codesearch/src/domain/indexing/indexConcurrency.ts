import { flushWorkflowLog, getLogger, log } from "../../observability/logger.js"

/**
 * Limits how many repository index pipelines run at once on this codesearch
 * instance. Zoekt + SCIP indexing are memory-heavy; parallel runs on large repos
 * (e.g. kubernetes, llvm) can OOM the container even without persistent watchers.
 */
const MAX_CONCURRENT_INDEX_RUNS = 1

let activeIndexRuns = 0
const indexWaiters: Array<() => void> = []

function tryLogIndexEvent(
  step: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    const logger = getLogger()
    logger.set({ step, ...fields })
    logger.info(step)
    flushWorkflowLog()
  } catch {
    log.info({ step, ...fields, message: step })
  }
}

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
): Promise<T> {
  const waiting = activeIndexRuns >= MAX_CONCURRENT_INDEX_RUNS
  if (waiting) {
    tryLogIndexEvent("codesearch.index.queue.wait")
  }
  await acquireIndexSlot()
  tryLogIndexEvent("codesearch.index.queue.acquired")
  try {
    return await fn()
  } finally {
    releaseIndexSlot()
    tryLogIndexEvent("codesearch.index.queue.released")
  }
}
