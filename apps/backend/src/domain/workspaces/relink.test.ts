import { describe, expect, it } from "vitest"
import { nextRelinkFields } from "./relink.js"

describe("nextRelinkFields", () => {
  it("bumps generation and resets write/hydrate, not the slug", () => {
    const next = nextRelinkFields(1)
    expect(next).toEqual({
      desiredGeneration: 2,
      desiredSha: null,
      hydrateStatus: "pending",
      hydrateError: null,
      writeStatus: "unknown",
      readOnlyReason: null,
    })
    expect(next).not.toHaveProperty("slug")
    expect(next).not.toHaveProperty("activeProjectionUrl")
    expect(next).not.toHaveProperty("activeProjectionSha")
  })

  it("stores the classified write probe on relink", () => {
    expect(
      nextRelinkFields(3, {
        writeStatus: "read_only",
        readOnlyReason: "not GitHub",
      }),
    ).toMatchObject({
      desiredGeneration: 4,
      writeStatus: "read_only",
      readOnlyReason: "not GitHub",
    })
  })
})
