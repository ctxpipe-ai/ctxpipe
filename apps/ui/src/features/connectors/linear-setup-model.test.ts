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
      getLinearWizardBodyId({ ...liveStatus, selectedScopeCount: 0 }),
    ).toBe("scope")
    expect(
      getLinearWizardBodyId({ ...liveStatus, setupPhase: "awaiting_merge" }),
    ).toBe("merge")
    expect(getLinearWizardBodyId(liveStatus)).toBe("complete")
  })

  it("keeps failed sync visible and recoverable", () => {
    const failed = { ...liveStatus, setupPhase: "sync_failed" as const }
    expect(getLinearSetupCurrentIndex(failed)).toBe(
      LINEAR_SETUP_STEPS.findIndex((step) => step.id === "merge"),
    )
    expect(getLinearCardPrimaryCta(failed)).toEqual({
      kind: "open_wizard",
      label: "Review failure",
    })
  })
})
