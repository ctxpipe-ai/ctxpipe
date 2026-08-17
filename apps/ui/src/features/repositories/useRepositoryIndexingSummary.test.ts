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
    ).toMatchObject({
      totalCount: 3,
      activeCount: 2,
      queuedCount: 1,
      runningCount: 1,
      failedCount: 0,
      singleActiveStepLabel: null,
    })
  })

  it("reports failed repositories separately", () => {
    expect(
      getRepositoryIndexingSummary([
        { indexingStatus: "failed" },
        { indexingStatus: "running" },
      ]),
    ).toMatchObject({
      totalCount: 2,
      activeCount: 1,
      queuedCount: 0,
      runningCount: 1,
      failedCount: 1,
      singleActiveStepLabel: null,
    })
  })

  it("supports legacy indexReady responses", () => {
    expect(
      getRepositoryIndexingSummary([
        { indexReady: true },
        { indexReady: false },
      ]),
    ).toMatchObject({
      totalCount: 2,
      activeCount: 1,
      queuedCount: 0,
      runningCount: 1,
      failedCount: 0,
      singleActiveStepLabel: null,
    })
  })

  it("returns singleActiveStepLabel when exactly one active repo has step data", () => {
    expect(
      getRepositoryIndexingSummary([
        {
          indexingStatus: "running",
          indexingStep: 7,
          indexingStepTotal: 22,
          indexingStepKey: "embedding",
        },
        { indexingStatus: "ready" },
      ]),
    ).toMatchObject({
      activeCount: 1,
      singleActiveStepLabel: "embedding 7/22",
    })
  })

  it("returns singleActiveStepLabel for a queued repo with step data", () => {
    expect(
      getRepositoryIndexingSummary([
        {
          indexingStatus: "queued",
          indexingStep: 1,
          indexingStepTotal: 22,
          indexingStepKey: "queued",
        },
        { indexingStatus: "ready" },
      ]),
    ).toMatchObject({
      activeCount: 1,
      queuedCount: 1,
      singleActiveStepLabel: "queued 1/22",
    })
  })

  it("keeps singleActiveStepLabel available when another repo failed", () => {
    expect(
      getRepositoryIndexingSummary([
        {
          indexingStatus: "running",
          indexingStep: 7,
          indexingStepTotal: 22,
          indexingStepKey: "embedding",
        },
        { indexingStatus: "failed" },
      ]),
    ).toMatchObject({
      activeCount: 1,
      failedCount: 1,
      singleActiveStepLabel: "embedding 7/22",
    })
  })

  it("returns null singleActiveStepLabel when single active repo has no step data", () => {
    expect(
      getRepositoryIndexingSummary([
        {
          indexingStatus: "running",
          indexingStep: null,
          indexingStepTotal: null,
          indexingStepKey: null,
        },
      ]),
    ).toMatchObject({
      activeCount: 1,
      singleActiveStepLabel: null,
    })
  })

  it("returns null singleActiveStepLabel when multiple repos are active", () => {
    expect(
      getRepositoryIndexingSummary([
        {
          indexingStatus: "running",
          indexingStep: 7,
          indexingStepTotal: 22,
          indexingStepKey: "embedding",
        },
        {
          indexingStatus: "queued",
          indexingStep: 1,
          indexingStepTotal: 22,
          indexingStepKey: "queued",
        },
      ]),
    ).toMatchObject({
      activeCount: 2,
      singleActiveStepLabel: null,
    })
  })
})
