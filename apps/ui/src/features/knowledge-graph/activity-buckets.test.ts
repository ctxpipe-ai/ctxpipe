import { describe, expect, it } from "vitest"

import { activityBuckets } from "./activity-buckets"

const DAY = 24 * 60 * 60 * 1000
const jul21 = Date.parse("2026-07-21T11:00:00.000Z")

describe("activityBuckets", () => {
  it("covers at least one week, also when all stamps are on one day", () => {
    const buckets = activityBuckets([jul21], { minBuckets: 4, maxBuckets: 16 })
    expect(buckets).toEqual({
      counts: [1, 0, 0, 0],
      rangeStart: jul21,
      rangeEnd: jul21 + 7 * DAY,
      lastStamp: jul21,
      total: 1,
    })
  })

  it("keeps the last stamp apart from the end of the range", () => {
    const stamps = [jul21, jul21 + 2 * DAY, jul21 + 3 * DAY]
    const buckets = activityBuckets(stamps, { minBuckets: 6, maxBuckets: 24 })
    expect(buckets?.lastStamp).toBe(jul21 + 3 * DAY)
    expect(buckets?.rangeEnd).toBe(jul21 + 7 * DAY)
    expect(buckets?.counts).toHaveLength(6)
    expect(buckets?.total).toBe(3)
  })

  it("puts the last stamp of a long range into the last bucket", () => {
    const stamps = [jul21, jul21 + 70 * DAY]
    const buckets = activityBuckets(stamps, { minBuckets: 4, maxBuckets: 16 })
    expect(buckets?.counts).toHaveLength(10)
    expect(buckets?.counts.at(-1)).toBe(1)
    expect(buckets?.rangeEnd).toBe(jul21 + 70 * DAY)
  })

  it("has no buckets for no stamps", () => {
    expect(activityBuckets([], { minBuckets: 4, maxBuckets: 16 })).toBeNull()
  })
})
