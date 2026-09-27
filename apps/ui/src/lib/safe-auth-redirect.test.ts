import { describe, expect, it } from "vitest"
import { safeAuthRedirectPath } from "./safe-auth-redirect"

describe("safeAuthRedirectPath", () => {
  it("keeps a same-origin auth path", () => {
    expect(
      safeAuthRedirectPath(
        "/.auth/accept-invitation?invitationId=inv_1",
        "/.auth/sign-in",
      ),
    ).toBe("/.auth/accept-invitation?invitationId=inv_1")
  })

  it("rejects absolute and protocol-relative URLs", () => {
    expect(
      safeAuthRedirectPath("https://evil.example/", "/.auth/sign-in"),
    ).toBe("/.auth/sign-in")
    expect(safeAuthRedirectPath("//evil.example", "/.auth/sign-in")).toBe(
      "/.auth/sign-in",
    )
    expect(safeAuthRedirectPath("/\\evil.example", "/.auth/sign-in")).toBe(
      "/.auth/sign-in",
    )
  })
})
