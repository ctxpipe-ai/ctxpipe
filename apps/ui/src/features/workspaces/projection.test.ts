import { describe, expect, it } from "vitest"
import {
  workspaceHydrateInFlight,
  workspaceProjectionReady,
} from "./projection"

describe("workspaceProjectionReady", () => {
  it("serves chat once a projection SHA exists, including during relink", () => {
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
    expect(
      workspaceProjectionReady({
        hydrateStatus: "pending",
        activeProjectionSha: "aaa",
      }),
    ).toBe(true)
  })
})

describe("workspaceHydrateInFlight", () => {
  it("keeps polling while relink hydrates a new desired SHA", () => {
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "ready",
        desiredSha: "aaa",
        activeProjectionSha: "aaa",
      }),
    ).toBe(false)
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "pending",
        desiredSha: "bbb",
        activeProjectionSha: "aaa",
      }),
    ).toBe(true)
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "ready",
        desiredSha: "bbb",
        activeProjectionSha: "aaa",
      }),
    ).toBe(true)
  })
})
