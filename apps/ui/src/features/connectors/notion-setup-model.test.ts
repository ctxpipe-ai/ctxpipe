import { describe, expect, it } from "vitest"
import {
  getNotionCardCtaLabel,
  getNotionFailureAction,
  getNotionSetupCurrentIndex,
  getNotionSetupSteps,
  hasNotionScopeChanged,
  NOTION_SETUP_STEPS,
  SELF_HOSTED_NOTION_SETUP_STEPS,
  shouldShowNotionRegisterStep,
  shouldShowNotionSetupComplete,
} from "./notion-setup-model"

const page = {
  externalId: "page-1",
  type: "page" as const,
  title: "Handbook",
}
const database = {
  externalId: "database-1",
  type: "database" as const,
  title: "People",
}

describe("Notion setup model", () => {
  it("shows completion when initial setup becomes live", () => {
    expect(
      shouldShowNotionSetupComplete(
        { setupPhase: "live", selectedResourceCount: null },
        false,
      ),
    ).toBe(true)
  })

  it("opens the scope editor when live scope management was requested", () => {
    expect(
      shouldShowNotionSetupComplete(
        { setupPhase: "live", selectedResourceCount: 2 },
        true,
      ),
    ).toBe(false)
  })

  it("prepends register only when the deployment has no shared Notion app", () => {
    expect(getNotionSetupSteps()).toEqual(NOTION_SETUP_STEPS)
    expect(
      getNotionSetupSteps({
        oauthAppSaved: false,
        globalNotionOAuthConfigured: true,
      }),
    ).toEqual(NOTION_SETUP_STEPS)
    expect(
      getNotionSetupSteps({
        oauthAppSaved: false,
        globalNotionOAuthConfigured: false,
      }),
    ).toEqual(SELF_HOSTED_NOTION_SETUP_STEPS)
    expect(
      shouldShowNotionRegisterStep({
        oauthAppSaved: false,
        globalNotionOAuthConfigured: false,
      }),
    ).toBe(true)
    expect(
      shouldShowNotionRegisterStep({
        oauthAppSaved: true,
        globalNotionOAuthConfigured: false,
      }),
    ).toBe(false)
    expect(
      shouldShowNotionRegisterStep({
        oauthAppSaved: false,
        globalNotionOAuthConfigured: true,
      }),
    ).toBe(false)
  })

  it("keeps an uninstalled self-host draft on the register step", () => {
    const status = {
      isGithubLinked: false,
      syncTargetConfigured: false,
      selectedResourceCount: 0,
      setupPhase: "draft",
      pendingConfigPullUrl: null,
      isInstalled: false,
    }
    const selfHost = {
      oauthAppSaved: false,
      globalNotionOAuthConfigured: false,
    }
    const saved = {
      oauthAppSaved: true,
      globalNotionOAuthConfigured: false,
    }

    expect(getNotionSetupCurrentIndex(status, selfHost)).toBe(0)
    expect(getNotionSetupCurrentIndex(status, saved)).toBe(0)
    expect(getNotionCardCtaLabel(status, selfHost)).toBe("Register integration")
    expect(getNotionCardCtaLabel(status, saved)).toBe("Connect Notion")
  })

  it("uses lifecycle state when status omits the Git-backed count", () => {
    const live = {
      isGithubLinked: true,
      syncTargetConfigured: true,
      selectedResourceCount: null,
      setupPhase: "live",
      pendingConfigPullUrl: null,
    }

    expect(getNotionSetupCurrentIndex(live)).toBe(NOTION_SETUP_STEPS.length)
    expect(getNotionCardCtaLabel(live)).toBe("Manage scope")
  })

  it("treats reordered scope as unchanged", () => {
    expect(hasNotionScopeChanged([page, database], [database, page])).toBe(
      false,
    )
  })

  it("detects a changed resource selection", () => {
    expect(hasNotionScopeChanged([page], [page, database])).toBe(true)
  })

  it("maps failed phases to their retry actions", () => {
    expect(getNotionFailureAction({ setupPhase: "sync_failed" })).toBe(
      "retry_content",
    )
    expect(getNotionFailureAction({ setupPhase: "config_failed" })).toBe(
      "retry_config",
    )
    expect(getNotionFailureAction({ setupPhase: "live" })).toBeNull()
  })

  it("keeps failed content sync on the merge step even without loaded scope", () => {
    const status = {
      isGithubLinked: true,
      syncTargetConfigured: true,
      selectedResourceCount: 0,
      setupPhase: "sync_failed",
      pendingConfigPullUrl: null,
    }

    expect(getNotionSetupCurrentIndex(status)).toBe(
      NOTION_SETUP_STEPS.findIndex((step) => step.id === "merge"),
    )
    expect(getNotionCardCtaLabel(status)).toBe("Review failure")
  })

  it("returns a pre-PR configuration failure to resource selection", () => {
    const status = {
      isGithubLinked: true,
      syncTargetConfigured: true,
      selectedResourceCount: 0,
      setupPhase: "config_failed",
      pendingConfigPullUrl: null,
    }

    expect(getNotionSetupCurrentIndex(status)).toBe(
      NOTION_SETUP_STEPS.findIndex((step) => step.id === "scope"),
    )
    expect(getNotionCardCtaLabel(status)).toBe("Review failure")
  })

  it("keeps configuration failure with a draft pull request on merge", () => {
    expect(
      getNotionSetupCurrentIndex({
        isGithubLinked: true,
        syncTargetConfigured: true,
        selectedResourceCount: 1,
        setupPhase: "config_failed",
        pendingConfigPullUrl: "https://github.com/acme/context/pull/3",
      }),
    ).toBe(NOTION_SETUP_STEPS.findIndex((step) => step.id === "merge"))
  })

  it("stays on merge while a config PR is creating or open even if git resource count is 0", () => {
    expect(
      getNotionSetupCurrentIndex({
        isGithubLinked: true,
        syncTargetConfigured: true,
        selectedResourceCount: 0,
        setupPhase: "awaiting_merge",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: true,
      }),
    ).toBe(NOTION_SETUP_STEPS.findIndex((step) => step.id === "merge"))
    expect(
      getNotionSetupCurrentIndex({
        isGithubLinked: true,
        syncTargetConfigured: true,
        selectedResourceCount: 0,
        setupPhase: "awaiting_merge",
        pendingConfigPullUrl: "https://github.com/acme/context/pull/9",
        pendingConfigPrCreating: false,
      }),
    ).toBe(NOTION_SETUP_STEPS.findIndex((step) => step.id === "merge"))
    expect(
      getNotionCardCtaLabel({
        setupPhase: "awaiting_merge",
        selectedResourceCount: 0,
        pendingConfigPrCreating: true,
      }),
    ).toBe("Continue setup")
  })
})
