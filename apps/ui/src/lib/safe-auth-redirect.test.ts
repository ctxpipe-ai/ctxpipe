import { describe, expect, it } from "vitest"
import { safeAuthRedirectPath } from "./safe-auth-redirect"

const origin = "https://app.example"
const fallback = "/.auth/sign-in"

describe("safeAuthRedirectPath", () => {
  it("keeps a same-origin auth path", () => {
    expect(
      safeAuthRedirectPath(
        "/.auth/accept-invitation?invitationId=inv_1",
        fallback,
        origin,
      ),
    ).toBe("/.auth/accept-invitation?invitationId=inv_1")
  })

  it("keeps the path of an absolute URL on the same origin", () => {
    // The account-exists email links sign-in back with an absolute URL.
    expect(
      safeAuthRedirectPath(
        `${origin}/.auth/accept-invitation?invitationId=inv_1#join`,
        fallback,
        origin,
      ),
    ).toBe("/.auth/accept-invitation?invitationId=inv_1#join")
  })

  it.each([
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    " //evil.example",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,hi",
    "http://app.example/",
    "/.//evil.example",
    "/./\\evil.example",
    "/x/..//evil.example",
    "/%2e//evil.example",
    `${origin}//evil.example`,
    `${origin}/\\evil.example`,
  ])("does not leave the origin for %j", (value) => {
    expect(safeAuthRedirectPath(value, fallback, origin)).toBe(fallback)
  })

  it("uses the fallback when there is no value", () => {
    expect(safeAuthRedirectPath(null, fallback, origin)).toBe(fallback)
    expect(safeAuthRedirectPath("", fallback, origin)).toBe(fallback)
  })
})
