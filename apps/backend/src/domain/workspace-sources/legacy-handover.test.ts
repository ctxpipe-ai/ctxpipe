import { describe, expect, it } from "vitest"
import { createLogger, withLogger } from "../../observability/logger.js"
import { legacyBindingHandedOver } from "./legacy-handover.js"

describe("legacyBindingHandedOver", () => {
  it("lets the legacy sync run when the handover lookup fails", async () => {
    const handedOver = await withLogger(
      createLogger({ test: "handover" }),
      () =>
        legacyBindingHandedOver(
          "pagerduty",
          {
            orgId: "org_any",
            connectionId: "con_any",
            repositoryGitUrl: "https://github.com/acme/any.git",
          },
          async () => {
            throw new Error("database is down")
          },
        ),
    )
    expect(handedOver).toBe(false)
  })
})
