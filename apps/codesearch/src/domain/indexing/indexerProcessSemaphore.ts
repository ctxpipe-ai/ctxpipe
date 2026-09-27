/**
 * Fixed, in-memory admission for memory-heavy indexer child processes.
 *
 * This lives at the Bun.spawn boundary so direct phase API calls and the
 * legacy composer share the same process limit.
 */
import { getIndexerProcessConcurrency } from "./capacityEnv.js"

/** Default when CODESEARCH_INDEXER_CONCURRENCY is unset (kubernetes memory gate). */
export const INDEXER_PROCESS_CONCURRENCY = 2

let activeIndexerProcesses = 0
const indexerProcessWaiters: Array<() => void> = []

function releaseIndexerProcessSlot(): void {
  activeIndexerProcesses = Math.max(0, activeIndexerProcesses - 1)
  const next = indexerProcessWaiters.shift()
  if (next) next()
}

async function acquireIndexerProcessSlot(): Promise<void> {
  const cap = getIndexerProcessConcurrency()
  if (activeIndexerProcesses < cap) {
    activeIndexerProcesses += 1
    return
  }

  await new Promise<void>((resolve) => {
    indexerProcessWaiters.push(() => {
      activeIndexerProcesses += 1
      resolve()
    })
  })
}

export async function withIndexerProcessSlot<T>(
  fn: () => Promise<T>,
): Promise<T> {
  await acquireIndexerProcessSlot()
  try {
    return await fn()
  } finally {
    releaseIndexerProcessSlot()
  }
}

export function resetIndexerProcessSemaphoreForTests(): void {
  activeIndexerProcesses = 0
  indexerProcessWaiters.length = 0
}
