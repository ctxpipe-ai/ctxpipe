import { describe, expect, it } from "vitest"
import { getConfluenceWizardBodyId } from "./confluence-setup-model"
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
