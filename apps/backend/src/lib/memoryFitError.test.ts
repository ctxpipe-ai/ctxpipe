import { describe, expect, it } from "vitest"
import {
  CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY,
  isCodesearchTaskDeath,
  isMemoryFitFailure,
  memoryFitLogFields,
  userFacingIndexingError,
} from "./memoryFitError.js"

describe("isMemoryFitFailure", () => {
  it("detects indexer SIGKILL exit 137", () => {
    expect(
      isMemoryFitFailure(new Error("Command failed with exit code 137")),
    ).toBe(true)
  })

  it("does not treat undici fetch failed as memory-fit outside codesearch phases", () => {
    expect(isMemoryFitFailure(new TypeError("fetch failed"))).toBe(false)
  })

  it("does not treat ECONNRESET as memory-fit outside codesearch phases", () => {
    const cause = new Error("socket hang up") as NodeJS.ErrnoException
    cause.code = "ECONNRESET"
    expect(isMemoryFitFailure(new TypeError("fetch failed", { cause }))).toBe(
      false,
    )
  })

  it("detects ENOMEM errno", () => {
    const mem = new Error("Cannot allocate memory") as NodeJS.ErrnoException
    mem.code = "ENOMEM"
    expect(isMemoryFitFailure(mem)).toBe(true)
  })

  it("does not treat unrelated errors as memory-fit", () => {
    expect(isMemoryFitFailure(new Error("Repository not found"))).toBe(false)
    expect(
      isMemoryFitFailure(new Error("Command failed with exit code 1")),
    ).toBe(false)
  })
})

describe("isCodesearchTaskDeath", () => {
  it("detects undici TypeError fetch failed", () => {
    expect(isCodesearchTaskDeath(new TypeError("fetch failed"))).toBe(true)
  })

  it("detects ECONNRESET and EPIPE on nested cause", () => {
    const reset = new Error("socket hang up") as NodeJS.ErrnoException
    reset.code = "ECONNRESET"
    const pipe = new Error("write EPIPE") as NodeJS.ErrnoException
    pipe.code = "EPIPE"
    expect(
      isCodesearchTaskDeath(new TypeError("fetch failed", { cause: reset })),
    ).toBe(true)
    expect(isCodesearchTaskDeath(pipe)).toBe(true)
  })
})

describe("userFacingIndexingError", () => {
  it("rewrites exit 137 to the canonical memory message", () => {
    expect(
      userFacingIndexingError(
        new Error("Command failed with exit code 137\nstderr: killed"),
      ),
    ).toBe(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
  })

  it("passes through extract fetch failed", () => {
    expect(userFacingIndexingError(new TypeError("fetch failed"))).toBe(
      "fetch failed",
    )
  })

  it("passes through unrelated messages", () => {
    expect(userFacingIndexingError(new Error("Repository not found"))).toBe(
      "Repository not found",
    )
  })
})

describe("memoryFitLogFields", () => {
  it("extracts errno and cause message from a nested fetch failure", () => {
    const cause = new Error("read ECONNRESET") as NodeJS.ErrnoException
    cause.code = "ECONNRESET"
    expect(
      memoryFitLogFields(new TypeError("fetch failed", { cause })),
    ).toEqual({
      errno: "ECONNRESET",
      cause: "read ECONNRESET",
    })
  })
})
