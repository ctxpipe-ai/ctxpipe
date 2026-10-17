import { describe, expect, it } from "vitest"
import { legacyBindingHandedOver } from "./legacy-handover.js"

describe("legacyBindingHandedOver", () => {
  // Some legacy workflows (Confluence) run with no logger in their context.
  it("lets the legacy sync run when the handover lookup fails, with no logger in the context", async () => {
    const handedOver = await legacyBindingHandedOver(
      "pagerduty",
      {
        orgId: "org_any",
        connectionId: "con_any",
        repositoryGitUrl: "https://github.com/acme/any.git",
      },
      async () => {
        throw new Error("database is down")
      },
    )
    expect(handedOver).toBe(false)
  })
})
