import { describe, expect, it } from "vitest"

import {
  getPagerdutyCardCtaLabel,
  getPagerdutySetupCurrentIndex,
  getPagerdutySetupSteps,
  PAGERDUTY_SELF_HOSTED_SETUP_STEPS,
  PAGERDUTY_SETUP_STEPS,
} from "./pagerduty-setup-model"

const hosted = { globalPagerdutyOAuthConfigured: true, oauthAppSaved: false }
const selfHost = { globalPagerdutyOAuthConfigured: false, oauthAppSaved: false }
const saved = { globalPagerdutyOAuthConfigured: false, oauthAppSaved: true }

describe("PagerDuty setup model", () => {
  it("prepends register only when the deployment has no shared PagerDuty app", () => {
    expect(getPagerdutySetupSteps(undefined)).toEqual(PAGERDUTY_SETUP_STEPS)
    expect(getPagerdutySetupSteps(hosted)).toEqual(PAGERDUTY_SETUP_STEPS)
    expect(getPagerdutySetupSteps(selfHost)).toEqual(
      PAGERDUTY_SELF_HOSTED_SETUP_STEPS,
    )
  })

  it("goes from register to connect to Add to Workspaces", () => {
    const draft = { isInstalled: false }
    const installed = { isInstalled: true }
    expect(getPagerdutySetupCurrentIndex(draft, selfHost)).toBe(0)
    expect(getPagerdutySetupCurrentIndex(draft, saved)).toBe(1)
    expect(getPagerdutySetupCurrentIndex(installed, saved)).toBe(2)
    expect(getPagerdutySetupCurrentIndex(draft, hosted)).toBe(0)
    expect(getPagerdutySetupCurrentIndex(installed, hosted)).toBe(1)
  })

  it("manages the connection once PagerDuty is connected", () => {
    expect(getPagerdutyCardCtaLabel({ isInstalled: false }, selfHost)).toBe(
      "Register OAuth app",
    )
    expect(getPagerdutyCardCtaLabel({ isInstalled: false }, hosted)).toBe(
      "Connect PagerDuty",
    )
    expect(getPagerdutyCardCtaLabel({ isInstalled: true }, hosted)).toBe(
      "Manage",
    )
    expect(
      getPagerdutyCardCtaLabel(
        { isInstalled: false, installationStatus: "revoked" },
        hosted,
      ),
    ).toBe("Reconnect PagerDuty")
  })
})
