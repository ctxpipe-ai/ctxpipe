import { expect, it } from "vitest"

import { REINGEST_POLLS, reingestPollSeconds } from "./reingest.js"

// CTX-898: no event wakes a re-ingestion that waits for its turn. With a
// backoff to 15 minutes, a turn that came just after a check stayed unused
// for 14 minutes.
it("checks the turn of a waiting re-ingestion again within a minute at each poll", () => {
  const waits = Array.from({ length: 500 }, (_, poll) =>
    reingestPollSeconds(
      poll,
      REINGEST_POLLS.firstPollSeconds,
      REINGEST_POLLS.maxTurnPollSeconds,
    ),
  )
  expect(Math.max(...waits)).toBeLessThanOrEqual(60)
})
