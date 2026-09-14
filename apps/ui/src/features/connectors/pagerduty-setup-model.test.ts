import { describe, expect, it } from "vitest"
import {
  getPagerdutyCardCtaLabel,
  getPagerdutySetupCurrentIndex,
  hasPagerdutyScopeChanged,
} from "./pagerduty-setup-model"

describe("PagerDuty setup model", () => {
  it("opens manage scope when live", () => {
    expect(
      getPagerdutyCardCtaLabel({
        setupPhase: "live",
        selectedServiceCount: 2,
      }),
    ).toBe("Manage scope")
  })

  it("keeps the merge step while a config PR is pending", () => {
    expect(
      getPagerdutySetupCurrentIndex({
        isGithubLinked: true,
        syncTargetConfigured: true,
        setupPhase: "awaiting_merge",
        selectedServiceCount: null,
        pendingConfigPullUrl: "https://github.com/acme/repo/pull/1",
        pendingConfigPrCreating: false,
      }),
    ).toBe(3)
  })

  it("detects service selection changes", () => {
    expect(
      hasPagerdutyScopeChanged([{ id: "A" }], [{ id: "A" }, { id: "B" }]),
    ).toBe(true)
  })
})
