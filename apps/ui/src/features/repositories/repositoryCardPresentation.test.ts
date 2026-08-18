import { describe, expect, it } from "vitest"
import { repositoryCardPresentation } from "./repositoryCardPresentation"

const memoryError = "Codebase didn't fit available memory"

describe("repositoryCardPresentation", () => {
  it("surfaces the stored Zoekt issue, retry, and queryable icon for complete_with_issues", () => {
    expect(
      repositoryCardPresentation({
        indexingStatus: "complete_with_issues",
        indexingError: memoryError,
        lastIngestedHash: "abc1234",
        lastIngestedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      displayStatus: "complete_with_issues",
      issuesDetail: memoryError,
      failedDetail: null,
      showRetryIndexing: true,
      queryable: true,
    })
  })

  it("labels first-run task OOM as failed with the memory-fit error and retry", () => {
    expect(
      repositoryCardPresentation({
        indexingStatus: "failed",
        indexingError: memoryError,
        lastIngestedHash: null,
        lastIngestedAt: null,
      }),
    ).toMatchObject({
      displayStatus: "failed",
      failedDetail: memoryError,
      issuesDetail: null,
      showRetryIndexing: true,
      queryable: false,
    })
  })

  it("labels task OOM after a prior success as out of date with the memory-fit error", () => {
    expect(
      repositoryCardPresentation({
        indexingStatus: "failed",
        indexingError: memoryError,
        lastIngestedHash: "abc123def456",
        lastIngestedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      displayStatus: "out-of-date",
      failedDetail: null,
      issuesDetail: null,
      showRetryIndexing: true,
      queryable: false,
      outOfDateDetail: {
        lastIngestedHash: "abc123def456",
        indexingError: memoryError,
      },
    })
  })

  it("does not offer retry while indexing is ready", () => {
    expect(
      repositoryCardPresentation({
        indexingStatus: "ready",
        indexingError: null,
        lastIngestedHash: "abc1234",
        lastIngestedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      displayStatus: "ready",
      showRetryIndexing: false,
    })
  })
})
