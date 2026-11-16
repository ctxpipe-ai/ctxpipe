/**
 * Fixed, in-memory admission for memory-heavy indexer child processes.
 *
 * This lives at the Bun.spawn boundary so direct phase API calls and the
 * legacy composer share the same process limit.
 */
import { getIndexerProcessConcurrency } from "./capacityEnv.js"

function createSemaphore(cap: () => number) {
  let active = 0
  const waiters: Array<() => void> = []
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < cap()) {
        active += 1
      } else {
        // The releasing run hands its place to the next waiter.
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
      try {
        return await fn()
      } finally {
        const next = waiters.shift()
        if (next) next()
        else active = Math.max(0, active - 1)
      }
    },
    reset(): void {
      active = 0
      waiters.length = 0
    },
  }
}

const processSlots = createSemaphore(getIndexerProcessConcurrency)
// A SCIP indexer can reach 2–2.6 GB; two of them beside the service go past
// 80% of a 6 GiB container. The host has two vCPUs, so a second one adds
// little speed. Zoekt keeps the other process slot.
const scipIndexerSlots = createSemaphore(() => 1)

export function withIndexerProcessSlot<T>(fn: () => Promise<T>): Promise<T> {
  return processSlots.run(fn)
}

/**
 * One SCIP indexer process at a time, inside a process slot. A waiting SCIP
 * indexer holds no process slot, so `zoekt-index` does not wait behind it.
 */
export function withScipIndexerSlot<T>(fn: () => Promise<T>): Promise<T> {
  return scipIndexerSlots.run(() => processSlots.run(fn))
}

export function resetIndexerProcessSemaphoreForTests(): void {
  processSlots.reset()
  scipIndexerSlots.reset()
}
