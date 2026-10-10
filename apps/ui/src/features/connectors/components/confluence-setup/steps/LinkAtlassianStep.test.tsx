import { describe, expect, it } from "vitest"
import { atlassianLinkReturnPath } from "./LinkAtlassianStep"

describe("atlassianLinkReturnPath", () => {
  it("returns to the connectors page with the wizard connection", () => {
    expect(
      atlassianLinkReturnPath("https://app.test/acme/connectors", "con_forge1"),
    ).toBe("/acme/connectors?atlassianConnectionId=con_forge1")
  })

  it("keeps the other search parameters", () => {
    expect(
      atlassianLinkReturnPath(
        "https://app.test/acme/connectors?pendingAccountClaim=x&atlassianConnectionId=old",
        "con_forge1",
      ),
    ).toBe(
      "/acme/connectors?pendingAccountClaim=x&atlassianConnectionId=con_forge1",
    )
  })
})
