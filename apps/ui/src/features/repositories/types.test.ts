import { describe, expect, it } from "vitest"
import {
  formatShortCommitHash,
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
