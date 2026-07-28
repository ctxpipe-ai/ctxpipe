export const SCIP_INDEXER_CONCURRENCY = 2

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
  const concurrency =
    typeof concurrencyOrWorker === "number"
      ? concurrencyOrWorker
      : SCIP_INDEXER_CONCURRENCY
  const worker =
    typeof concurrencyOrWorker === "function"
      ? concurrencyOrWorker
      : maybeWorker

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer")
  }
  if (!worker) {
    throw new TypeError("worker is required")
  }

  const results = new Array<Result>(items.length)
  const pending = items.entries()

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const next = pending.next()
        if (next.done) return
        const [index, item] = next.value
        results[index] = await worker(item, index)
      }
    },
  )

  await Promise.all(runners)
  return results
}
