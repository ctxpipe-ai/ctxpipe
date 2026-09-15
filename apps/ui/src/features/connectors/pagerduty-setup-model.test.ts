import { describe, expect, it } from "vitest"
import {
  getPagerdutyCardCtaLabel,
  getPagerdutySetupCurrentIndex,
  hasPagerdutyScopeChanged,
  PAGERDUTY_SETUP_STEPS,
} from "./pagerduty-setup-model"

const draftUninstalled = {
  isInstalled: false,
  isGithubLinked: false,
  syncTargetConfigured: false,
  setupPhase: "draft",
  selectedServiceCount: null,
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
}

const draftInstalled = {
  ...draftUninstalled,
  isInstalled: true,
}

describe("PagerDuty setup model", () => {
  it("starts on Connect before PagerDuty is authorised", () => {
    expect(PAGERDUTY_SETUP_STEPS[0]?.id).toBe("connect")
    expect(getPagerdutySetupCurrentIndex(draftUninstalled)).toBe(0)
    expect(getPagerdutyCardCtaLabel(draftUninstalled)).toBe("Connect PagerDuty")
  })

  it("names the next unfinished setup step on the card", () => {
    expect(
      getPagerdutyCardCtaLabel({
        ...draftInstalled,
        isGithubLinked: false,
      }),
    ).toBe("Link GitHub")
    expect(
      getPagerdutyCardCtaLabel({
        ...draftInstalled,
        isGithubLinked: true,
        syncTargetConfigured: false,
      }),
    ).toBe("Select repository")
    expect(
      getPagerdutyCardCtaLabel({
        ...draftInstalled,
        isGithubLinked: true,
        syncTargetConfigured: true,
        setupPhase: "draft",
      }),
    ).toBe("Choose services")
  })

  it("opens manage scope when live", () => {
    expect(
      getPagerdutyCardCtaLabel({
        isInstalled: true,
        isGithubLinked: true,
        syncTargetConfigured: true,
        setupPhase: "live",
        selectedServiceCount: 2,
        pendingConfigPullUrl: null,
      }),
    ).toBe("Manage scope")
  })

  it("keeps the merge step while a config PR is pending", () => {
    expect(
      getPagerdutySetupCurrentIndex({
        isInstalled: true,
        isGithubLinked: true,
        syncTargetConfigured: true,
        setupPhase: "awaiting_merge",
        selectedServiceCount: null,
        pendingConfigPullUrl: "https://github.com/acme/repo/pull/1",
        pendingConfigPrCreating: false,
      }),
    ).toBe(PAGERDUTY_SETUP_STEPS.findIndex((step) => step.id === "merge"))
  })

  it("detects service selection changes", () => {
    expect(
      hasPagerdutyScopeChanged([{ id: "A" }], [{ id: "A" }, { id: "B" }]),
    ).toBe(true)
  })
})
