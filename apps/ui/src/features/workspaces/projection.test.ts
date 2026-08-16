import { describe, expect, it } from "vitest"
import { workspaceProjectionReady } from "./projection"

describe("workspaceProjectionReady", () => {
  it("blocks chat until hydrate activates a SHA", () => {
    expect(
      workspaceProjectionReady({
        hydrateStatus: "pending",
        activeProjectionSha: null,
      }),
    ).toBe(false)
    expect(
      workspaceProjectionReady({
        hydrateStatus: "ready",
        activeProjectionSha: "abc",
      }),
    ).toBe(true)
  })
})
