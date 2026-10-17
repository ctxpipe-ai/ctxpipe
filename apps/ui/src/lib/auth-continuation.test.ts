import { describe, expect, it } from "vitest"
import {
  getAuthContinuationProps,
  getOAuthRedirectUri,
} from "./auth-continuation"

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

describe("getOAuthRedirectUri", () => {
  it("accepts Better Auth redirect response shapes", () => {
    expect(
      getOAuthRedirectUri({ redirect_uri: "https://client.example/a" }),
    ).toBe("https://client.example/a")
    expect(getOAuthRedirectUri({ url: "https://client.example/b" })).toBe(
      "https://client.example/b",
    )
  })

  it("does not return non-string or empty redirect values", () => {
    expect(getOAuthRedirectUri({ redirect_uri: null })).toBeUndefined()
    expect(getOAuthRedirectUri({ url: "" })).toBeUndefined()
    expect(getOAuthRedirectUri(null)).toBeUndefined()
  })
})
