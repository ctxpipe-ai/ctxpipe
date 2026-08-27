import { describe, expect, it } from "vitest"
import {
  combineWorkspaceSignals,
  decayWorkspaceSignal,
  sourceHalfLifeMs,
} from "./claim-confidence.js"

describe("decayWorkspaceSignal", () => {
  it("is zero outside the half-open window and c_max at valid_from", () => {
    const now = new Date("2026-06-01T00:00:00.000Z")
    expect(
      decayWorkspaceSignal({
        confidence: 0.8,
        validFrom: "2026-07-01T00:00:00.000Z",
        validTo: null,
        source: "git",
        now,
      }),
    ).toBe(0)
    expect(
      decayWorkspaceSignal({
        confidence: 0.8,
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-06-01T00:00:00.000Z",
        source: "git",
        now,
      }),
    ).toBe(0)
    expect(
      decayWorkspaceSignal({
        confidence: 0.8,
        validFrom: "2026-06-01T00:00:00.000Z",
        validTo: "2026-12-01T00:00:00.000Z",
        source: "git",
        now,
      }),
    ).toBe(0.8)
  })

  it("decays evergreen git signals with a 365-day half-life", () => {
    expect(sourceHalfLifeMs("git")).toBe(365 * 24 * 60 * 60 * 1000)
    expect(sourceHalfLifeMs("../../linear/issues/PAY-12.md")).toBe(
      120 * 24 * 60 * 60 * 1000,
    )
    expect(
      sourceHalfLifeMs("https://github.com/acme/billing.git#apps/api/src/ledger.ts"),
    ).toBe(365 * 24 * 60 * 60 * 1000)
    expect(sourceHalfLifeMs("../src/lib/auth.ts")).toBe(
      365 * 24 * 60 * 60 * 1000,
    )
    expect(
      decayWorkspaceSignal({
        confidence: 0.8,
        validFrom: "2025-08-16T00:00:00.000Z",
        validTo: null,
        source: "git",
        now: new Date("2026-08-16T00:00:00.000Z"),
      }),
    ).toBeCloseTo(0.4, 5)
  })
})

describe("combineWorkspaceSignals", () => {
  it("returns the single energy and damps two equal maxima above max", () => {
    expect(combineWorkspaceSignals([0.8])).toBe(0.8)
    expect(combineWorkspaceSignals([0.8, 0.8])).toBeCloseTo(0.84, 5)
    expect(combineWorkspaceSignals([0, 0.8])).toBe(0.8)
  })
})
