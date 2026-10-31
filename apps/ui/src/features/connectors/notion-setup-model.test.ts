import { describe, expect, it } from "vitest"

import {
  getNotionCardCtaLabel,
  getNotionSetupCurrentIndex,
  getNotionSetupSteps,
  NOTION_SETUP_STEPS,
  SELF_HOSTED_NOTION_SETUP_STEPS,
  shouldShowNotionRegisterStep,
  shouldShowNotionWebhookStep,
} from "./notion-setup-model"

const selfHost = { oauthAppSaved: false, globalNotionOAuthConfigured: false }
const saved = { oauthAppSaved: true, globalNotionOAuthConfigured: false }
const webhookReady = { ...saved, webhookConfigured: true }
const hosted = { oauthAppSaved: false, globalNotionOAuthConfigured: true }

describe("Notion setup model", () => {
  it("prepends register and webhook only when the deployment has no shared Notion app", () => {
    expect(getNotionSetupSteps()).toEqual(NOTION_SETUP_STEPS)
    expect(getNotionSetupSteps(hosted)).toEqual(NOTION_SETUP_STEPS)
    expect(getNotionSetupSteps(selfHost)).toEqual(
      SELF_HOSTED_NOTION_SETUP_STEPS,
    )
    expect(shouldShowNotionRegisterStep(selfHost)).toBe(true)
    expect(shouldShowNotionRegisterStep(saved)).toBe(false)
    expect(shouldShowNotionWebhookStep(saved)).toBe(true)
    expect(shouldShowNotionRegisterStep(hosted)).toBe(false)
    expect(shouldShowNotionWebhookStep(hosted)).toBe(false)
  })

  it("keeps an uninstalled self-host draft on register, then webhook, then connect", () => {
    const draft = { setupPhase: "draft", isInstalled: false }
    expect(getNotionSetupCurrentIndex(draft, selfHost)).toBe(0)
    expect(getNotionSetupCurrentIndex(draft, saved)).toBe(1)
    expect(getNotionSetupCurrentIndex(draft, webhookReady)).toBe(2)
    expect(getNotionCardCtaLabel(draft, selfHost)).toBe("Register OAuth app")
    expect(getNotionCardCtaLabel(draft, saved)).toBe("Add webhook")
    expect(getNotionCardCtaLabel(draft, webhookReady)).toBe("Connect Notion")
  })

  it("goes from connect to Add to Workspaces", () => {
    const draft = { setupPhase: "draft", isInstalled: false }
    const installed = { setupPhase: "draft", isInstalled: true }
    expect(getNotionSetupCurrentIndex(draft, hosted)).toBe(0)
    expect(getNotionSetupCurrentIndex(installed, hosted)).toBe(1)
    expect(getNotionSetupCurrentIndex(installed, webhookReady)).toBe(3)
  })

  it("manages the connection once Notion is connected, also for an old live binding", () => {
    expect(
      getNotionCardCtaLabel({ setupPhase: "live", isInstalled: true }, hosted),
    ).toBe("Manage")
    expect(getNotionCardCtaLabel({ setupPhase: "draft" }, hosted)).toBe(
      "Connect Notion",
    )
  })
})
