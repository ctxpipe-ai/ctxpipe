import { describe, expect, it } from "vitest"
import {
  connectorHealthLabel,
  formatSelectedItemCount,
  isFailedSetupPhase,
} from "./connectorHealth"

describe("connectorHealthLabel", () => {
  it("uses the three operator-facing states plus checking", () => {
    expect(connectorHealthLabel("checking")).toBe("Checking")
    expect(connectorHealthLabel("not_connected")).toBe("Not yet connected")
    expect(connectorHealthLabel("connected")).toBe("Connected")
    expect(connectorHealthLabel("error")).toBe("Error")
  })
})

describe("formatSelectedItemCount", () => {
  it("pluralises", () => {
    expect(formatSelectedItemCount(1)).toBe("1 selected item")
    expect(formatSelectedItemCount(4)).toBe("4 selected items")
  })
})

describe("isFailedSetupPhase", () => {
  it("treats sync and config failures as errors", () => {
    expect(isFailedSetupPhase("sync_failed")).toBe(true)
    expect(isFailedSetupPhase("config_failed")).toBe(true)
    expect(isFailedSetupPhase("live")).toBe(false)
  })
})
