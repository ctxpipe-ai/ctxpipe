import { describe, expect, it } from "vitest"
import {
  workspaceHydrateInFlight,
  workspaceHydrateView,
  workspacePrepareNeedsPoll,
  workspaceProjectionReady,
} from "./projection"

describe("workspaceProjectionReady", () => {
  it("serves chat once a projection SHA exists after migration export", () => {
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
    ).toBe(false)
    expect(
      workspaceProjectionReady({
        hydrateStatus: "pending",
        activeProjectionSha: "aaa",
        migrationExportSha: "export",
      }),
    ).toBe(true)
    expect(
      workspaceProjectionReady({
        hydrateStatus: "ready",
        activeProjectionSha: "aaa",
        writeStatus: "writable",
      }),
    ).toBe(false)
    expect(
      workspaceProjectionReady({
        hydrateStatus: "ready",
        activeProjectionSha: "aaa",
        writeStatus: "read_only",
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

  it("is failed when pending still carries a hydrateError", () => {
    expect(
      workspaceHydrateView({
        hydrateStatus: "pending",
        desiredSha: "87797371c413",
        activeProjectionSha: null,
        hydrateError: "Waiting for the first knowledge export to land in git.",
      }),
    ).toBe("failed")
    expect(
      workspacePrepareNeedsPoll({
        hydrateStatus: "pending",
        desiredSha: "87797371c413",
        activeProjectionSha: null,
        hydrateError: "Waiting for the first knowledge export to land in git.",
        migrationExportSha: null,
      }),
    ).toBe(false)
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

describe("workspacePrepareNeedsPoll", () => {
  it("keeps polling until export-backed chat is ready, except a failed prepare", () => {
    expect(
      workspacePrepareNeedsPoll({
        hydrateStatus: "ready",
        desiredSha: "aaa",
        activeProjectionSha: "aaa",
      }),
    ).toBe(true)
    expect(
      workspacePrepareNeedsPoll({
        hydrateStatus: "failed",
        desiredSha: "aaa",
        activeProjectionSha: null,
        migrationExportSha: null,
      }),
    ).toBe(false)
    expect(
      workspacePrepareNeedsPoll({
        hydrateStatus: "ready",
        desiredSha: "aaa",
        activeProjectionSha: "aaa",
        writeStatus: "read_only",
      }),
    ).toBe(false)
    expect(
      workspacePrepareNeedsPoll({
        hydrateStatus: "ready",
        desiredSha: "aaa",
        activeProjectionSha: "aaa",
        migrationExportSha: "export",
      }),
    ).toBe(false)
    expect(
      workspacePrepareNeedsPoll({
        hydrateStatus: "failed",
        desiredSha: "bbb",
        activeProjectionSha: "aaa",
        migrationExportSha: "export",
      }),
    ).toBe(false)
  })
})
