import { describe, expect, it } from "vitest"
import {
  CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY,
  errorFromIndexerExit,
  isMemoryFitFailure,
  userFacingIndexingError,
} from "./memoryFitError.js"

describe("errorFromIndexerExit", () => {
  it("maps exit 137 to the canonical memory-fit message", () => {
    const error = errorFromIndexerExit({
      exitCode: 137,
      stderr: "Killed",
      stdout: "",
      headline: "Command failed with exit code 137",
    })
    expect(error.message).toBe(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
    expect(isMemoryFitFailure(error)).toBe(true)
  })

  it("keeps non-OOM indexer failures as the original headline", () => {
    const error = errorFromIndexerExit({
      exitCode: 1,
      stderr: "parse error",
      stdout: "",
      headline: "Command failed with exit code 1",
    })
    expect(error.message).toContain("exit code 1")
    expect(error.message).toContain("parse error")
    expect(isMemoryFitFailure(error)).toBe(false)
  })
})

describe("userFacingIndexingError", () => {
  it("rewrites exit 137 headlines to the canonical memory message", () => {
    expect(
      userFacingIndexingError(new Error("Command failed with exit code 137")),
    ).toBe(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
  })

  it("does not remap unrelated fetch failed", () => {
    expect(userFacingIndexingError(new TypeError("fetch failed"))).toBe(
      "fetch failed",
    )
  })
})
