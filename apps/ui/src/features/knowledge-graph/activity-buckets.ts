const WEEK = 7 * 24 * 60 * 60 * 1000

/** A weekly histogram of observation stamps, for the activity sparklines. */
export type ActivityBuckets = {
  counts: number[]
  /** The first stamp: the start of the first bucket. */
  rangeStart: number
  /** The end of the last bucket: at least one week after `rangeStart`. */
  rangeEnd: number
  /** The newest stamp. It can be before `rangeEnd`. */
  lastStamp: number
  total: number
}

/**
 * Buckets the stamps by week, with `minBuckets` to `maxBuckets` buckets. The
 * buckets cover at least one week, also when all the stamps are on one day.
 */
export function activityBuckets(
  stamps: readonly number[],
  limits: { minBuckets: number; maxBuckets: number },
): ActivityBuckets | null {
  if (stamps.length === 0) return null
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const stamp of stamps) {
    if (stamp < min) min = stamp
    if (stamp > max) max = stamp
  }
  const span = Math.max(max - min, WEEK)
  const bucketCount = Math.min(
    limits.maxBuckets,
    Math.max(limits.minBuckets, Math.ceil(span / WEEK)),
  )
  const bucketSize = span / bucketCount
  const counts = new Array<number>(bucketCount).fill(0)
  for (const stamp of stamps) {
    const index = Math.min(
      bucketCount - 1,
      Math.floor((stamp - min) / bucketSize),
    )
    counts[index] = (counts[index] ?? 0) + 1
  }
  return {
    counts,
    rangeStart: min,
    rangeEnd: min + span,
    lastStamp: max,
    total: stamps.length,
  }
}
