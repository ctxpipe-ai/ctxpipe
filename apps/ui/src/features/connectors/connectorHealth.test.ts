import { describe, expect, it } from "vitest"
import {
  connectorHealthLabel,
  formatSelectedItemCount,
  resolveConnectorHealth,
} from "./connectorHealth"

describe("connectorHealthLabel", () => {
  it("names the operator-facing states", () => {
    expect(connectorHealthLabel("checking")).toBe("Checking")
    expect(connectorHealthLabel("not_connected")).toBe("Not yet connected")
    expect(connectorHealthLabel("connected")).toBe("Connected")
    expect(connectorHealthLabel("couldnt_load")).toBe("Couldn't load")
    expect(connectorHealthLabel("sync_failed")).toBe("Sync failed")
    expect(connectorHealthLabel("config_failed")).toBe("Config PR failed")
  })
})

describe("formatSelectedItemCount", () => {
  it("pluralises", () => {
    expect(formatSelectedItemCount(1)).toBe("1 selected item")
    expect(formatSelectedItemCount(4)).toBe("4 selected items")
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
      }),
    ).toBe("sync_failed")
    expect(
      resolveConnectorHealth({
        statusError: false,
        checking: false,
        setupPhase: "config_failed",
        connected: false,
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
      }),
    ).toBe("connected")
    expect(
      resolveConnectorHealth({
        statusError: false,
        checking: true,
        connected: false,
      }),
    ).toBe("checking")
    expect(
      resolveConnectorHealth({
        statusError: false,
        checking: false,
        setupPhase: "draft",
        connected: false,
      }),
    ).toBe("not_connected")
  })
})
