import { DrizzleQueryError } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { loggableZendeskError } from "./access-token.js"

describe("loggableZendeskError", () => {
  it("keeps the query parameters of a failed query out of the log text", () => {
    const cause = Object.assign(new Error("deadlock detected"), {
      code: "40P01",
    })
    const error = new DrizzleQueryError(
      'update "connections" set "config" = $1',
      ["v1:encrypted-access-token-fixture"],
      cause,
    )

    const text = loggableZendeskError(error)

    expect(text).not.toContain("encrypted-access-token-fixture")
    expect(text).toBe("Query failed: deadlock detected (40P01)")
  })

  it("keeps the message of another error", () => {
    expect(
      loggableZendeskError(new Error("Zendesk token refresh failed (500)")),
    ).toBe("Zendesk token refresh failed (500)")
  })
})
