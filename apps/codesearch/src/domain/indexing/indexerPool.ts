import { INDEXER_PROCESS_CONCURRENCY } from "./indexerProcessSemaphore.js"

export const SCIP_INDEXER_CONCURRENCY = INDEXER_PROCESS_CONCURRENCY

type AsyncWorker<Item, Result> = (item: Item, index: number) => Promise<Result>

export function runWithConcurrency<Item, Result>(
  items: readonly Item[],
  worker: AsyncWorker<Item, Result>,
): Promise<Result[]>
export function runWithConcurrency<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  worker: AsyncWorker<Item, Result>,
): Promise<Result[]>
export function runWithConcurrency<Item, Result>(
  items: readonly Item[],
  concurrency: undefined,
  worker: AsyncWorker<Item, Result>,
): Promise<Result[]>
export async function runWithConcurrency<Item, Result>(
  items: readonly Item[],
  concurrencyOrWorker:
    | number
    | AsyncWorker<Item, Result> = SCIP_INDEXER_CONCURRENCY,
  maybeWorker?: AsyncWorker<Item, Result>,
): Promise<Result[]> {
  const requestedConcurrency =
    typeof concurrencyOrWorker === "number"
      ? concurrencyOrWorker
      : SCIP_INDEXER_CONCURRENCY
  const worker =
    typeof concurrencyOrWorker === "function"
      ? concurrencyOrWorker
      : maybeWorker

  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) {
    throw new RangeError("concurrency must be a positive integer")
  }
  if (!worker) {
    throw new TypeError("worker is required")
  }

  const concurrency = Math.min(requestedConcurrency, SCIP_INDEXER_CONCURRENCY)
  const results = new Array<Result>(items.length)
  const pending = items.entries()
  let didFail = false
  let firstFailure: unknown

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (!didFail) {
        const next = pending.next()
        if (next.done) return
        const [index, item] = next.value
        try {
          results[index] = await worker(item, index)
        } catch (error) {
          if (!didFail) {
            didFail = true
            firstFailure = error
          }
          return
        }
      }
    },
  )

  await Promise.all(runners)
  if (didFail) throw firstFailure
  return results
}
