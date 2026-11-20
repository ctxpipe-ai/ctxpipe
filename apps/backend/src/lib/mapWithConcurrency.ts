/**
 * Call `fn` on each item, with at most `limit` calls in flight, and return
 * the results in the order of `items`. After a call fails, no new call
 * starts. The result rejects with the first error, after the calls that
 * were in flight end, so that no call of it runs after it settles.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  // The workers share one iterator, so each item goes to one worker.
  const queue = items.entries()
  let failure: { error: unknown } | undefined
  const worker = async () => {
    for (const [index, item] of queue) {
      if (failure) return
      try {
        out[index] = await fn(item)
      } catch (error) {
        failure ??= { error }
        return
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  )
  if (failure) throw failure.error
  return out
}
