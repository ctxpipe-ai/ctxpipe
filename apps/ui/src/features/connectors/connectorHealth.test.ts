import { describe, expect, it } from "vitest"
import { connectorHealthLabel, resolveConnectorHealth } from "./connectorHealth"

describe("connectorHealthLabel", () => {
  it("names the operator-facing states", () => {
    expect(connectorHealthLabel("checking")).toBe("Checking")
    expect(connectorHealthLabel("setup_pending")).toBe("Setup not finished")
    expect(connectorHealthLabel("awaiting_merge")).toBe("Awaiting merge")
    expect(connectorHealthLabel("reconnect")).toBe("Needs reconnect")
    expect(connectorHealthLabel("syncing")).toBe("Syncing")
    expect(connectorHealthLabel("connected")).toBe("Connected")
    expect(connectorHealthLabel("couldnt_load")).toBe("Couldn't load")
    expect(connectorHealthLabel("sync_failed")).toBe("Sync failed")
    expect(connectorHealthLabel("config_failed")).toBe("Config PR failed")
  })
})

describe("resolveConnectorHealth", () => {
  it("prefers a failed status fetch over a stale setup phase", () => {
    expect(
      resolveConnectorHealth({
        statusError: true,
        checking: false,
        setupPhase: "live",
        connected: true,
        draft: false,
      }),
    ).toBe("couldnt_load")
  })

  it("maps Linear/Notion failure phases before connected", () => {
    expect(
      resolveConnectorHealth({
        statusError: false,
        checking: false,
        setupPhase: "sync_failed",
        connected: false,
        draft: false,
      }),
    ).toBe("sync_failed")
    expect(
      resolveConnectorHealth({
        statusError: false,
        checking: false,
        setupPhase: "config_failed",
        connected: false,
        draft: false,
      }),
    ).toBe("config_failed")
  })

  it("treats live as connected and anything else as not yet connected", () => {
    expect(
      resolveConnectorHealth({
        statusError: false,
        checking: false,
        setupPhase: "live",
        connected: true,
        draft: false,
      }),
    ).toBe("connected")
    expect(
      resolveConnectorHealth({
        statusError: false,
        checking: true,
        connected: false,
        draft: false,
      }),
    ).toBe("checking")
    expect(
      resolveConnectorHealth({
        statusError: false,
        checking: false,
        setupPhase: "draft",
        connected: false,
        draft: true,
      }),
    ).toBe("setup_pending")
    expect(
      resolveConnectorHealth({
        statusError: false,
        checking: false,
        setupPhase: "initial_sync",
        connected: false,
        draft: false,
      }),
    ).toBe("syncing")
  })

  it("shows setup not finished only for a draft row", () => {
    const base = { statusError: false, checking: false, connected: false }
    expect(
      resolveConnectorHealth({ ...base, setupPhase: "live", draft: false }),
    ).toBe("reconnect")
    expect(
      resolveConnectorHealth({
        ...base,
        setupPhase: "awaiting_merge",
        draft: false,
      }),
    ).toBe("awaiting_merge")
    expect(resolveConnectorHealth({ ...base, draft: true })).toBe(
      "setup_pending",
    )
  })

  it("shows reconnect for a revoked or uninstalled row in any phase", () => {
    const base = { statusError: false, checking: false }
    for (const installationStatus of ["revoked", "uninstalled"]) {
      expect(
        resolveConnectorHealth({
          ...base,
          installationStatus,
          setupPhase: "live",
          connected: true,
          draft: false,
        }),
      ).toBe("reconnect")
      expect(
        resolveConnectorHealth({
          ...base,
          installationStatus,
          setupPhase: "draft",
          connected: false,
          draft: true,
        }),
      ).toBe("reconnect")
    }
  })
})
