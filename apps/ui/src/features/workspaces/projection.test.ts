import { describe, expect, it } from "vitest"
import {
  workspaceHydrateInFlight,
  workspaceHydrateView,
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

describe("workspaceHydrateView", () => {
  it("is waiting for a tip while pending with no desired SHA", () => {
    expect(
      workspaceHydrateView({
        hydrateStatus: "pending",
        desiredSha: null,
        hydrateError: null,
      }),
    ).toBe("waiting_for_tip")
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "pending",
        desiredSha: null,
        hydrateError: null,
      }),
    ).toBe(true)
  })

  it("is hydrating when a desired SHA is not the active projection", () => {
    expect(
      workspaceHydrateView({
        hydrateStatus: "pending",
        desiredSha: "abc123def456",
        activeProjectionSha: null,
        hydrateError: null,
      }),
    ).toBe("hydrating")
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "pending",
        desiredSha: "bbb",
        activeProjectionSha: "aaa",
      }),
    ).toBe(true)
    expect(
      workspaceHydrateView({
        hydrateStatus: "ready",
        desiredSha: "bbb",
        activeProjectionSha: "aaa",
        hydrateError: null,
      }),
    ).toBe("hydrating")
  })

  it("is failed when hydrateStatus is failed", () => {
    expect(
      workspaceHydrateView({
        hydrateStatus: "failed",
        desiredSha: null,
        hydrateError: "getLogger: no logger in context.",
      }),
    ).toBe("failed")
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "failed",
        desiredSha: null,
        hydrateError: "getLogger: no logger in context.",
      }),
    ).toBe(false)
  })

  it("is ready when status is ready and SHAs match", () => {
    expect(
      workspaceHydrateView({
        hydrateStatus: "ready",
        desiredSha: "aaa",
        activeProjectionSha: "aaa",
        hydrateError: null,
      }),
    ).toBe("ready")
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "ready",
        desiredSha: "aaa",
        activeProjectionSha: "aaa",
      }),
    ).toBe(false)
  })
})
