import { describe, expect, it } from "vitest"
import {
  getConfluenceCardCurrentIndex,
  getConfluenceCardPrimaryCta,
  getConfluenceWizardBodyId,
  MANAGED_CONFLUENCE_WIZARD_STEPS,
} from "./confluence-setup-model"
import type { AtlassianConnectorStatus } from "./types"

const baseStatus: AtlassianConnectorStatus = {
  isLinked: true,
  isInstalled: false,
  installationStatus: null,
  isGithubLinked: false,
  selectedSpaceCount: 0,
  syncTargetConfigured: false,
  setupPhase: "draft",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: null,
  selectedSpaces: [],
}

describe("getConfluenceWizardBodyId Forge / wait coherence", () => {
  const managedOauth = {
    oauthAppSaved: true,
    atlassianOAuthClientId: "client",
    globalAtlassianOAuthConfigured: true,
    oauthCallbackUrl: "https://example/cb",
    atlassianCreateUrl: "https://developer.atlassian.com",
  } as const

  it("shows wait step when Forge is not installed and install intent was recorded", () => {
    expect(
      getConfluenceWizardBodyId(
        baseStatus,
        { waitForInstall: true },
        managedOauth,
      ),
    ).toBe("wait")
  })

  it("returns install step until user opens Marketplace or provisioning advances the wizard", () => {
    expect(
      getConfluenceWizardBodyId(
        baseStatus,
        { waitForInstall: false },
        managedOauth,
      ),
    ).toBe("install")
  })
})

describe("Confluence card primary action", () => {
  const configuredStatus: AtlassianConnectorStatus = {
    ...baseStatus,
    isInstalled: true,
    installationStatus: "installed",
    isGithubLinked: true,
    selectedSpaceCount: 1,
    syncTargetConfigured: true,
    setupPhase: "awaiting_merge",
  }

  it("continues setup while configuration is awaiting merge or syncing", () => {
    const currentIndex = getConfluenceCardCurrentIndex(
      configuredStatus,
      undefined,
    )

    expect(
      getConfluenceCardPrimaryCta(
        currentIndex,
        MANAGED_CONFLUENCE_WIZARD_STEPS,
      ),
    ).toEqual({ kind: "open_wizard", label: "Continue setup" })
  })

  it("manages scope after the connector is live", () => {
    const currentIndex = getConfluenceCardCurrentIndex(
      { ...configuredStatus, setupPhase: "live" },
      undefined,
    )

    expect(
      getConfluenceCardPrimaryCta(
        currentIndex,
        MANAGED_CONFLUENCE_WIZARD_STEPS,
      ),
    ).toEqual({ kind: "open_scope", label: "Manage scope" })
  })
})
