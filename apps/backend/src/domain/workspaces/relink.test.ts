import { describe, expect, it } from "vitest"
import { nextRelinkFields } from "./relink.js"

describe("nextRelinkFields", () => {
  it("bumps generation and resets write/hydrate, not the slug", () => {
    const next = nextRelinkFields(1)
    expect(next).toEqual({
      desiredGeneration: 2,
      desiredSha: null,
      hydrateStatus: "pending",
      writeStatus: "unknown",
      readOnlyReason: null,
    })
    expect(next).not.toHaveProperty("slug")
    expect(next).not.toHaveProperty("activeProjectionUrl")
    expect(next).not.toHaveProperty("activeProjectionSha")
  })
})
