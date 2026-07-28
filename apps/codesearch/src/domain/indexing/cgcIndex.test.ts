import { describe, expect, it } from "vitest"
import {
  assertCgcIndexSucceeded,
  cgcIndexArgsForIngestMode,
} from "./cgcIndex.js"

describe("cgcIndexArgsForIngestMode", () => {
  it("uses incremental index with force fallback for partial", () => {
    expect(cgcIndexArgsForIngestMode("partial")).toEqual({
      args: ["cgc", "index", "."],
      allowForceFallback: true,
    })
  })

  it("uses force-only index for full", () => {
    expect(cgcIndexArgsForIngestMode("full")).toEqual({
      args: ["cgc", "index", ".", "--force"],
      allowForceFallback: false,
    })
  })
})

describe("assertCgcIndexSucceeded", () => {
  it("accepts primary success", () => {
    expect(() =>
      assertCgcIndexSucceeded({ primaryExit: 0, allowForceFallback: true }),
    ).not.toThrow()
  })

  it("accepts force fallback success on partial", () => {
    expect(() =>
      assertCgcIndexSucceeded({
        primaryExit: 1,
        allowForceFallback: true,
        forceExit: 0,
      }),
    ).not.toThrow()
  })

  it("throws when primary and force fallback both fail", () => {
    expect(() =>
      assertCgcIndexSucceeded({
        primaryExit: 1,
        allowForceFallback: true,
        forceExit: 2,
      }),
    ).toThrow("cgc index failed with exit code 2")
  })

  it("throws when full ingest primary fails (no fallback)", () => {
    expect(() =>
      assertCgcIndexSucceeded({ primaryExit: 7, allowForceFallback: false }),
    ).toThrow("cgc index failed with exit code 7")
  })
})
