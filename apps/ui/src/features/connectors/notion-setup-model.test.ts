import { describe, expect, it } from "vitest"
import {
  getNotionCardCtaLabel,
  getNotionFailureAction,
  getNotionSetupCurrentIndex,
  hasNotionScopeChanged,
  NOTION_SETUP_STEPS,
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
        { setupPhase: "live", selectedResourceCount: 2 },
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
})
