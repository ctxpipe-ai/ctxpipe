import { describe, expect, it } from "vitest"

import { oauthErrorMessage } from "./atlassian-oauth-messages"

describe("oauthErrorMessage", () => {
  it("maps a known error without description", () => {
    const m = oauthErrorMessage("invalid_code")
    expect(m.title).toBeTruthy()
    expect(m.description).toContain("Start the connection again")
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
    expect(m.title).toBe("Could not link the account")
    // The next step comes first, then the code for a support request.
    expect(m.description).toBe(
      "Start the connection again. The error code is weird_key_xyz.",
    )
  })

  it("adds the next step after the text of the provider", () => {
    const m = oauthErrorMessage(
      "custom_provider_error",
      "The app is suspended.",
    )
    expect(m.description).toBe(
      "The app is suspended. Start the connection again.",
    )
  })
})
