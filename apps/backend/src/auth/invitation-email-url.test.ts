import { describe, expect, it } from "vitest"
import { invitationEmailLink } from "./invitation-email-url.js"

describe("invitationEmailLink", () => {
  it("lands on accept-invitation instead of sign-up", () => {
    expect(
      invitationEmailLink(
        "https://app.ctxpipe.ai",
        "invitation_1",
        "member@example.com",
      ),
    ).toBe(
      "https://app.ctxpipe.ai/.auth/accept-invitation?invitationId=invitation_1&email=member%40example.com",
    )
  })
})
