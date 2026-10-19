import { expect, it } from "vitest"
import { REINGEST_THROTTLE, reingestPollSeconds } from "./reingest.js"

// CTX-898: no event wakes a re-ingestion that waits for its slot. With a
// backoff to 15 minutes, a slot that freed just after a check stayed idle
// for 14 minutes.
it("checks the slot of a waiting re-ingestion again within a minute at each poll", () => {
  const waits = Array.from({ length: 500 }, (_, poll) =>
    reingestPollSeconds(
      poll,
      REINGEST_THROTTLE.firstPollSeconds,
      REINGEST_THROTTLE.maxSlotPollSeconds,
    ),
  )
  expect(Math.max(...waits)).toBeLessThanOrEqual(60)
})
