import { describe, expect, it } from "vitest"
import {
  CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY,
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

  it("detects undici TypeError fetch failed", () => {
    expect(isMemoryFitFailure(new TypeError("fetch failed"))).toBe(true)
  })

  it("detects ECONNRESET on nested cause", () => {
    const cause = new Error("socket hang up") as NodeJS.ErrnoException
    cause.code = "ECONNRESET"
    expect(isMemoryFitFailure(new TypeError("fetch failed", { cause }))).toBe(
      true,
    )
  })

  it("detects EPIPE and ENOMEM errnos", () => {
    const pipe = new Error("write EPIPE") as NodeJS.ErrnoException
    pipe.code = "EPIPE"
    const mem = new Error("Cannot allocate memory") as NodeJS.ErrnoException
    mem.code = "ENOMEM"
    expect(isMemoryFitFailure(pipe)).toBe(true)
    expect(isMemoryFitFailure(mem)).toBe(true)
  })

  it("does not treat unrelated errors as memory-fit", () => {
    expect(isMemoryFitFailure(new Error("Repository not found"))).toBe(false)
    expect(
      isMemoryFitFailure(new Error("Command failed with exit code 1")),
    ).toBe(false)
  })
})

describe("userFacingIndexingError", () => {
  it("rewrites fetch failed and exit 137 to the canonical memory message", () => {
    expect(userFacingIndexingError(new TypeError("fetch failed"))).toBe(
      CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY,
    )
    expect(
      userFacingIndexingError(
        new Error("Command failed with exit code 137\nstderr: killed"),
      ),
    ).toBe(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
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
