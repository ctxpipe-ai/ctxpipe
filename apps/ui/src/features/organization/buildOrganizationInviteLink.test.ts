import { describe, expect, it } from "vitest"
import { buildOrganizationInviteLink } from "./buildOrganizationInviteLink"

describe("buildOrganizationInviteLink", () => {
  it("matches backend invite redirect shape", () => {
    const url = buildOrganizationInviteLink({
      origin: "https://app.example.com",
      invitationId: "inv_abc",
      email: "a+b@example.com",
    })
    const parsed = new URL(url)
    expect(parsed.pathname).toBe("/.auth/sign-up")
    const redirectTo = parsed.searchParams.get("redirectTo")
    expect(redirectTo).toBeTruthy()
    const nested = new URL(
      `https://app.example.com${redirectTo}`,
      "https://app.example.com",
    )
    expect(nested.pathname).toBe("/.auth/accept-invitation")
    expect(nested.searchParams.get("invitationId")).toBe("inv_abc")
    expect(nested.searchParams.get("email")).toBe("a+b@example.com")
  })
})
