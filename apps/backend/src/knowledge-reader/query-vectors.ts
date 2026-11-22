/*
 * The query vectors of the last plane searches, by org and query text. An
 * agent often calls `get_related` with the query of its search, so the
 * second call needs no embedding call: about 640 ms of each `get_related`
 * of the question set v0 (CTX-1535).
 *
 * The org is part of the key, so the time of a call never shows that
 * another org asked the same text. The model and the dimension are config
 * of the process, so they are the same for each entry. A failed call keeps
 * nothing.
 */

/** About 8 KiB for each vector of 1024 numbers. */
const KEPT = 256

/** Newest last: the first key is the next one to go. */
const vectors = new Map<string, number[]>()

/**
 * The vector of `text` for `orgId`: the kept one, else the result of
 * `embed`, which is then kept.
 */
export async function queryVector(
  orgId: string,
  text: string,
  embed: () => Promise<number[]>,
): Promise<number[]> {
  const key = JSON.stringify([orgId, text])
  const kept = vectors.get(key)
  if (kept) {
    vectors.delete(key)
    vectors.set(key, kept)
    return kept
  }
  const vector = await embed()
  vectors.set(key, vector)
  for (const oldest of vectors.keys()) {
    if (vectors.size <= KEPT) break
    vectors.delete(oldest)
  }
  return vector
}
