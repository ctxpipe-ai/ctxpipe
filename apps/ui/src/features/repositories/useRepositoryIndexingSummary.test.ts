import { describe, expect, it } from "vitest"
import { getRepositoryIndexingSummary } from "./useRepositoryIndexingSummary"

describe("getRepositoryIndexingSummary", () => {
  it("counts queued and running repositories as active", () => {
    expect(
      getRepositoryIndexingSummary([
        { indexingStatus: "queued" },
        { indexingStatus: "running" },
        { indexingStatus: "ready" },
      ]),
    ).toEqual({ totalCount: 3, activeCount: 2, failedCount: 0 })
  })

  it("reports failed repositories separately", () => {
    expect(
      getRepositoryIndexingSummary([
        { indexingStatus: "failed" },
        { indexingStatus: "running" },
      ]),
    ).toEqual({ totalCount: 2, activeCount: 1, failedCount: 1 })
  })

  it("supports legacy indexReady responses", () => {
    expect(
      getRepositoryIndexingSummary([
        { indexReady: true },
        { indexReady: false },
      ]),
    ).toEqual({ totalCount: 2, activeCount: 1, failedCount: 0 })
  })
})
