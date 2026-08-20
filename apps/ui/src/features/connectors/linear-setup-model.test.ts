import { describe, expect, it } from "vitest"
import {
  getLinearCardPrimaryCta,
  getLinearSetupCurrentIndex,
  getLinearWizardBodyId,
  LINEAR_SETUP_STEPS,
} from "./linear-setup-model"
import type { LinearConnectorStatus } from "./queries/linear-connector"

const liveStatus = {
  isInstalled: true,
  installationStatus: "installed",
  workspaceName: "Acme",
  isGithubLinked: true,
  selectedScopeCount: 2,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/context",
    githubConnectionId: "github_1",
    branch: "main",
  },
} satisfies LinearConnectorStatus

describe("Linear setup model", () => {
  it("routes each incomplete server state to the first unfinished step", () => {
    expect(
      getLinearWizardBodyId({
        ...liveStatus,
        isInstalled: false,
        syncTarget: null,
        selectedScopeCount: 0,
        setupPhase: "draft",
      }),
    ).toBe("connect")
    expect(
      getLinearWizardBodyId({ ...liveStatus, isGithubLinked: false }),
    ).toBe("github")
    expect(getLinearWizardBodyId({ ...liveStatus, syncTarget: null })).toBe(
      "target",
    )
    expect(
      getLinearWizardBodyId({
        ...liveStatus,
        selectedScopeCount: null,
        setupPhase: "draft",
      }),
    ).toBe("scope")
    expect(
      getLinearWizardBodyId({ ...liveStatus, setupPhase: "awaiting_merge" }),
    ).toBe("merge")
    expect(getLinearWizardBodyId(liveStatus)).toBe("complete")
    expect(
      getLinearWizardBodyId({ ...liveStatus, selectedScopeCount: null }),
    ).toBe("complete")
    expect(getLinearCardPrimaryCta(liveStatus)).toEqual({
      kind: "manage_scope",
      label: "Manage scope",
    })
  })

  it("keeps failed sync visible and recoverable", () => {
    const syncFailed = { ...liveStatus, setupPhase: "sync_failed" as const }
    expect(getLinearSetupCurrentIndex(syncFailed)).toBe(
      LINEAR_SETUP_STEPS.findIndex((step) => step.id === "merge"),
    )
    expect(getLinearCardPrimaryCta(syncFailed)).toEqual({
      kind: "open_wizard",
      label: "Review failure",
    })

    const configFailedWithPr = {
      ...liveStatus,
      setupPhase: "config_failed" as const,
      pendingConfigPullUrl: "https://github.com/acme/context/pull/3",
    }
    expect(getLinearSetupCurrentIndex(configFailedWithPr)).toBe(
      LINEAR_SETUP_STEPS.findIndex((step) => step.id === "merge"),
    )
    expect(getLinearCardPrimaryCta(configFailedWithPr)).toEqual({
      kind: "open_wizard",
      label: "Review failure",
    })
  })

  it("sends a pre-PR configuration failure back to scope resubmit", () => {
    const failed = {
      ...liveStatus,
      selectedScopeCount: 0,
      setupPhase: "config_failed" as const,
      pendingConfigPullUrl: null,
    }

    expect(getLinearWizardBodyId(failed)).toBe("scope")
    expect(getLinearCardPrimaryCta(failed)).toEqual({
      kind: "open_wizard",
      label: "Configure scope",
    })
  })

  it("stays on merge while a config PR is creating or open even if git scope count is 0", () => {
    expect(
      getLinearWizardBodyId({
        ...liveStatus,
        selectedScopeCount: 0,
        setupPhase: "awaiting_merge",
        pendingConfigPrCreating: true,
        pendingConfigPullUrl: null,
      }),
    ).toBe("merge")
    expect(
      getLinearWizardBodyId({
        ...liveStatus,
        selectedScopeCount: 0,
        setupPhase: "awaiting_merge",
        pendingConfigPrCreating: false,
        pendingConfigPullUrl: "https://github.com/acme/context/pull/9",
      }),
    ).toBe("merge")
    expect(
      getLinearWizardBodyId({
        ...liveStatus,
        selectedScopeCount: 0,
        setupPhase: "initial_sync",
      }),
    ).toBe("merge")
  })
})
