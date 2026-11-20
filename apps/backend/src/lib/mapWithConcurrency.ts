/**
 * Call `fn` on each item, with at most `limit` calls in flight, and return
 * the results in the order of `items`. After a call fails, no new call
 * starts, and the result rejects with the first error.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  // The workers share one iterator, so each item goes to one worker.
  const queue = items.entries()
  let failed = false
  const worker = async () => {
    for (const [index, item] of queue) {
      if (failed) return
      try {
        out[index] = await fn(item)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  )
  return out
}
