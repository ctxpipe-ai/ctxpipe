import { describe, expect, it } from "vitest"
import { getAuthContinuationProps } from "./auth-continuation"

describe("getAuthContinuationProps", () => {
  it("extracts redirectTo when present", () => {
    const result = getAuthContinuationProps(
      "/.auth/sign-in",
      "?response_type=code&redirectTo=%2Fdocs&state=abc",
    )

    expect(result).toEqual({
      redirectTo: "/docs",
    })
  })

  it("returns undefined redirectTo when omitted", () => {
    const result = getAuthContinuationProps("/.auth/consent", "")

    expect(result).toEqual({
      redirectTo: undefined,
    })
  })
})
