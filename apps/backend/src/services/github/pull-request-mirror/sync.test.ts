import { describe, expect, it } from "vitest"
import { reviewDecisionFromReviews } from "./sync.js"

const review = (login: string, state: string, submittedAt: string) => ({
  author: { login, type: "human" as const },
  state,
  submittedAt,
})

describe("reviewDecisionFromReviews", () => {
  it("uses each reviewer's latest approval or change request", () => {
    expect(
      reviewDecisionFromReviews([
        review("bob", "CHANGES_REQUESTED", "2026-03-01T10:00:00Z"),
        review("bob", "APPROVED", "2026-03-02T10:00:00Z"),
      ]),
    ).toBe("APPROVED")
    expect(
      reviewDecisionFromReviews([
        review("bob", "APPROVED", "2026-03-01T10:00:00Z"),
        review("carol", "CHANGES_REQUESTED", "2026-03-02T10:00:00Z"),
      ]),
    ).toBe("CHANGES_REQUESTED")
  })

  it("ignores comments, dismissed and pending reviews", () => {
    expect(
      reviewDecisionFromReviews([
        review("bob", "COMMENTED", "2026-03-01T10:00:00Z"),
        review("bot", "DISMISSED", "2026-03-01T11:00:00Z"),
        review("dan", "PENDING", "2026-03-01T12:00:00Z"),
      ]),
    ).toBeNull()
    expect(reviewDecisionFromReviews([])).toBeNull()
  })
})
