import { describe, expect, it } from "vitest"
import {
  formatIndexingStepLabel,
  formatShortCommitHash,
  getBadgeWord,
  getRepositoryStatusDisplay,
} from "./types"

describe("getRepositoryStatusDisplay", () => {
  it("keeps failed without prior success as failed", () => {
    expect(
      getRepositoryStatusDisplay({
        indexingStatus: "failed",
        lastIngestedHash: null,
      }),
    ).toBe("failed")
  })

  it("maps failed with prior success to out-of-date", () => {
    expect(
      getRepositoryStatusDisplay({
        indexingStatus: "failed",
        lastIngestedHash: "abc123def456",
      }),
    ).toBe("out-of-date")
  })

  it("keeps running without prior success as running", () => {
    expect(
      getRepositoryStatusDisplay({
        indexingStatus: "running",
        lastIngestedHash: null,
      }),
    ).toBe("running")
  })

  it("maps running with prior success to refreshing", () => {
    expect(
      getRepositoryStatusDisplay({
        indexingStatus: "running",
        lastIngestedHash: "abc123def456",
      }),
    ).toBe("refreshing")
  })

  it("leaves ready and queued unchanged", () => {
    expect(
      getRepositoryStatusDisplay({
        indexingStatus: "ready",
        lastIngestedHash: "abc123def456",
      }),
    ).toBe("ready")
    expect(
      getRepositoryStatusDisplay({
        indexingStatus: "queued",
        lastIngestedHash: "abc123def456",
      }),
    ).toBe("queued")
  })
})

describe("formatShortCommitHash", () => {
  it("returns the first 7 characters", () => {
    expect(formatShortCommitHash("abcdef0123456789")).toBe("abcdef0")
  })
})

describe("getBadgeWord", () => {
  it("maps known base keys", () => {
    expect(getBadgeWord("embedding")).toBe("embedding")
    expect(getBadgeWord("cloning")).toBe("cloning")
    expect(getBadgeWord("queued")).toBe("queued")
    expect(getBadgeWord("index_queue")).toBe("indexing")
    expect(getBadgeWord("syncing_graph")).toBe("syncing")
    expect(getBadgeWord("identify_apis")).toBe("analyzing")
  })

  it("maps scip:<lang> keys to indexing", () => {
    expect(getBadgeWord("scip:go")).toBe("indexing")
    expect(getBadgeWord("scip:typescript")).toBe("indexing")
  })

  it("falls back to indexing for unknown keys", () => {
    expect(getBadgeWord("unknown_step")).toBe("indexing")
  })
})

describe("formatIndexingStepLabel", () => {
  it("formats step label from all three fields", () => {
    expect(
      formatIndexingStepLabel({
        indexingStep: 7,
        indexingStepTotal: 22,
        indexingStepKey: "embedding",
      }),
    ).toBe("embedding 7/22")
  })

  it("uses badge word for the key", () => {
    expect(
      formatIndexingStepLabel({
        indexingStep: 3,
        indexingStepTotal: 22,
        indexingStepKey: "syncing_graph",
      }),
    ).toBe("syncing 3/22")
  })

  it("returns null when any field is null", () => {
    expect(
      formatIndexingStepLabel({
        indexingStep: null,
        indexingStepTotal: 22,
        indexingStepKey: "embedding",
      }),
    ).toBeNull()

    expect(
      formatIndexingStepLabel({
        indexingStep: 7,
        indexingStepTotal: null,
        indexingStepKey: "embedding",
      }),
    ).toBeNull()

    expect(
      formatIndexingStepLabel({
        indexingStep: 7,
        indexingStepTotal: 22,
        indexingStepKey: null,
      }),
    ).toBeNull()
  })

  it("returns null when all fields are null", () => {
    expect(
      formatIndexingStepLabel({
        indexingStep: null,
        indexingStepTotal: null,
        indexingStepKey: null,
      }),
    ).toBeNull()
  })
})
