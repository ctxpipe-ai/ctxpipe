import { describe, expect, it } from "vitest"
import type { SlackConnectorStatus } from "./queries/slack-connector"
import {
  getSlackDraftStep,
  getSlackSetupPhaseLabel,
  getSlackSetupStepIndex,
  getSlackSetupView,
} from "./slack-setup-model"

const status = {
  isInstalled: true,
  installationStatus: "installed",
  teamName: "Acme",
  isGithubLinked: true,
  selectedChannelCount: 2,
  syncTargetConfigured: true,
  setupPhase: "draft",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  oldestDays: 90,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/context",
    branch: "main",
    githubConnectionId: "con_github",
  },
  selectedChannels: [
    { channelId: "C1", name: "engineering", isPrivate: false },
    { channelId: "C2", name: "product", isPrivate: true },
  ],
} satisfies SlackConnectorStatus

describe("getSlackSetupView", () => {
  it("does not misrepresent a failed status request as an OAuth step", () => {
    expect(
      getSlackSetupView({
        status: undefined,
        isPending: false,
        isError: true,
        showCompletion: false,
      }),
    ).toBe("error")
  })

  it("keeps users in the pull-request lifecycle after saving", () => {
    expect(
      getSlackSetupView({
        status: { ...status, pendingConfigPrCreating: true },
        isPending: false,
        showCompletion: true,
      }),
    ).toBe("creating_pr")
    expect(
      getSlackSetupView({
        status: { ...status, setupPhase: "awaiting_merge" },
        isPending: false,
        showCompletion: true,
      }),
    ).toBe("awaiting_merge")
    expect(
      getSlackSetupView({
        status: { ...status, setupPhase: "initial_sync" },
        isPending: false,
        showCompletion: true,
      }),
    ).toBe("initial_sync")
  })

  it("shows completion only after this dialog submitted configuration", () => {
    const live = { ...status, setupPhase: "live" as const }
    expect(
      getSlackSetupView({
        status: live,
        isPending: false,
        showCompletion: true,
      }),
    ).toBe("complete")
    expect(
      getSlackSetupView({
        status: live,
        isPending: false,
        showCompletion: false,
      }),
    ).toBe("configure")
  })

  it("gates configuration on Slack and GitHub connections", () => {
    expect(
      getSlackSetupView({
        status: undefined,
        isPending: false,
        showCompletion: false,
      }),
    ).toBe("authorize")
    expect(
      getSlackSetupView({
        status: { ...status, isGithubLinked: false },
        isPending: false,
        showCompletion: false,
      }),
    ).toBe("github")
  })
})

describe("Slack setup presentation", () => {
  it("uses separate channel and repository screens during draft setup", () => {
    expect(getSlackDraftStep({ ...status, selectedChannelCount: 0 })).toBe(
      "channels",
    )
    expect(
      getSlackDraftStep({
        ...status,
        selectedChannelCount: 2,
        syncTargetConfigured: false,
      }),
    ).toBe("target")
    expect(getSlackDraftStep({ ...status, setupPhase: "live" })).toBe(
      "channels",
    )
  })

  it("maps setup prerequisites and phases to step indexes", () => {
    expect(getSlackSetupStepIndex(undefined)).toBe(0)
    expect(getSlackSetupStepIndex({ ...status, isGithubLinked: false })).toBe(1)
    expect(getSlackSetupStepIndex({ ...status, selectedChannelCount: 0 })).toBe(
      2,
    )
    expect(
      getSlackSetupStepIndex({ ...status, syncTargetConfigured: false }),
    ).toBe(3)
    expect(
      getSlackSetupStepIndex({ ...status, setupPhase: "awaiting_merge" }),
    ).toBe(4)
    expect(getSlackSetupStepIndex({ ...status, setupPhase: "live" })).toBe(5)
  })

  it("uses human-readable connector status labels", () => {
    expect(
      getSlackSetupPhaseLabel({
        setupPhase: "awaiting_merge",
        pendingConfigPrCreating: false,
      }),
    ).toBe("Awaiting pull request merge")
    expect(
      getSlackSetupPhaseLabel({
        setupPhase: "live",
        pendingConfigPrCreating: false,
      }),
    ).toBe("Connected")
  })
})
