import { describe, expect, it } from "vitest"
import {
  estimateRefusal,
  isModelStepName,
  STEP_RESERVE_USD,
  spendGuard,
} from "./ingestionV2ProofBudget.js"

describe("estimateRefusal", () => {
  it("refuses when the p90 estimate for all sources is over the cap", () => {
    const reason = estimateRefusal({ costUsd: { low: 10, high: 31.5 } }, 30)
    expect(reason).toContain("31.5")
    expect(reason).toContain("30")
  })

  it("starts when the p90 estimate equals or is under the cap", () => {
    expect(estimateRefusal({ costUsd: { low: 1, high: 30 } }, 30)).toBeNull()
    expect(estimateRefusal({ costUsd: { low: 1, high: 4 } }, 30)).toBeNull()
  })
})

describe("spendGuard", () => {
  it("reserves the step maximum for each running model step", () => {
    const guard = spendGuard({
      spentUsd: 2,
      inFlightModelSteps: 3,
      capUsd: 30,
      reserveUsd: 0.5,
    })
    expect(guard).toEqual({ reservedUsd: 1.5, committedUsd: 3.5, stop: false })
  })

  it("stops when the spent and reserved total reaches the cap", () => {
    const base = { capUsd: 10, reserveUsd: 1, inFlightModelSteps: 4 }
    expect(spendGuard({ ...base, spentUsd: 5.99 }).stop).toBe(false)
    expect(spendGuard({ ...base, spentUsd: 6 }).stop).toBe(true)
  })

  it("stops a run with running steps before the finished spend reaches the cap", () => {
    // Finished spend alone (8) is under the cap (10); two running steps hold 2.
    expect(
      spendGuard({
        spentUsd: 8,
        inFlightModelSteps: 2,
        capUsd: 10,
        reserveUsd: 1,
      }).stop,
    ).toBe(true)
    expect(
      spendGuard({
        spentUsd: 8,
        inFlightModelSteps: 0,
        capUsd: 10,
        reserveUsd: 1,
      }).stop,
    ).toBe(false)
  })

  it("uses the default reserve", () => {
    expect(
      spendGuard({ spentUsd: 0, inFlightModelSteps: 2, capUsd: 30 })
        .reservedUsd,
    ).toBe(2 * STEP_RESERVE_USD)
  })
})

describe("isModelStepName", () => {
  it("counts a root model step and a repository model step", () => {
    expect(isModelStepName("skill:src/app~0123456789ab:apis:ws_1")).toBe(true)
    expect(isModelStepName("skill:repository:decisions:ws_1")).toBe(true)
    expect(isModelStepName("skill:repository:decisions.2:ws_1")).toBe(true)
  })

  it("does not count a script step or another step", () => {
    expect(isModelStepName("skill:repository:libraries:ws_1")).toBe(false)
    expect(isModelStepName("ensure-sandbox")).toBe(false)
  })
})
