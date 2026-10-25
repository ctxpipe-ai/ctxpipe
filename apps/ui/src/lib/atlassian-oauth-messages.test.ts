import { describe, expect, it } from "vitest"

import { oauthErrorMessage } from "./atlassian-oauth-messages"

describe("oauthErrorMessage", () => {
  it("maps a known error without description", () => {
    const m = oauthErrorMessage("invalid_code")
    expect(m.title).toBeTruthy()
    expect(m.description).toContain("Connectors")
  })

  it("uses description when present for a known key", () => {
    const m = oauthErrorMessage(
      "account_already_linked_to_different_user",
      "Custom",
    )
    expect(m.title).toBeTruthy()
    expect(m.description).toBe("Custom")
  })

  it.each([
    "account_already_linked_to_different_user",
    "unable_to_link_account",
    "email_doesn't_match",
    "invalid_code",
    "no_code",
    "state_mismatch",
    "please_restart_the_process",
  ])(
    "names no provider for %s, because the error redirect carries none",
    (error) => {
      // A GitHub, Google, or Microsoft link fails through the same redirect.
      const m = oauthErrorMessage(error)
      expect(`${m.title} ${m.description}`).not.toMatch(/Atlassian/)
    },
  )

  it("says how to fix an account that another user linked", () => {
    const m = oauthErrorMessage("account_already_linked_to_different_user")
    expect(m.title).toBe("This account is linked to another ctxpipe user")
    expect(m.description).toContain("Unlink")
  })

  it("falls back for unknown error keys", () => {
    const m = oauthErrorMessage("weird_key_xyz")
    expect(m.title).toBe("Connection issue")
    expect(m.description).toContain("weird key xyz")
  })
})
