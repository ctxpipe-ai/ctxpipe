import { describe, expect, it } from "vitest"
import {
  getPagerdutyCardCtaLabel,
  getPagerdutySetupCurrentIndex,
  getPagerdutySetupSteps,
  hasPagerdutyScopeChanged,
  PAGERDUTY_HOSTED_SETUP_STEPS,
  PAGERDUTY_SELF_HOSTED_SETUP_STEPS,
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

const hostedOauth = {
  globalPagerdutyOAuthConfigured: true,
  oauthAppSaved: false,
}

const selfHostOauth = {
  globalPagerdutyOAuthConfigured: false,
  oauthAppSaved: false,
}

describe("PagerDuty setup model", () => {
  it("starts on Connect before PagerDuty is authorised when env supplies the app", () => {
    expect(getPagerdutySetupSteps(hostedOauth)[0]?.id).toBe("connect")
    expect(getPagerdutySetupCurrentIndex(draftUninstalled, hostedOauth)).toBe(0)
    expect(getPagerdutyCardCtaLabel(draftUninstalled, hostedOauth)).toBe(
      "Connect PagerDuty",
    )
  })

  it("starts on Register when the deployment has no OAuth app", () => {
    expect(getPagerdutySetupSteps(selfHostOauth)).toEqual(
      PAGERDUTY_SELF_HOSTED_SETUP_STEPS,
    )
    expect(getPagerdutySetupCurrentIndex(draftUninstalled, selfHostOauth)).toBe(
      0,
    )
    expect(getPagerdutyCardCtaLabel(draftUninstalled, selfHostOauth)).toBe(
      "Register OAuth app",
    )
  })

  it("moves to Connect after a self-host OAuth app is saved", () => {
    expect(
      getPagerdutySetupCurrentIndex(draftUninstalled, {
        globalPagerdutyOAuthConfigured: false,
        oauthAppSaved: true,
      }),
    ).toBe(
      PAGERDUTY_SELF_HOSTED_SETUP_STEPS.findIndex(
        (step) => step.id === "connect",
      ),
    )
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

  it("asks to reconnect when authorization is revoked", () => {
    expect(
      getPagerdutyCardCtaLabel({
        ...draftUninstalled,
        installationStatus: "revoked",
      }),
    ).toBe("Reconnect PagerDuty")
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
    ).toBe(PAGERDUTY_HOSTED_SETUP_STEPS.findIndex((step) => step.id === "merge"))
  })

  it("detects service selection changes", () => {
    expect(
      hasPagerdutyScopeChanged([{ id: "A" }], [{ id: "A" }, { id: "B" }]),
    ).toBe(true)
  })
})
