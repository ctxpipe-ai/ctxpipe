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

  it("falls back for unknown error keys", () => {
    const m = oauthErrorMessage("weird_key_xyz")
    expect(m.title).toBe("Connection issue")
    expect(m.description).toContain("weird key xyz")
  })
})
