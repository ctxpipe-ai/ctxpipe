import { describe, expect, it } from "vitest"
import type { SlackConnectorStatus } from "./queries/slack-connector"
import {
  getSlackSetupPhaseLabel,
  getSlackSetupStepIndex,
  getSlackSetupView,
} from "./slack-setup-model"

const status = {
  isInstalled: true,
  installationStatus: "installed",
  teamName: "Acme",
  isGithubLinked: true,
  setupPhase: "draft",
  syncTarget: null,
} satisfies SlackConnectorStatus

describe("getSlackSetupView", () => {
  it("does not misrepresent a failed status request as an OAuth step", () => {
    expect(
      getSlackSetupView({ status: undefined, isPending: false, isError: true }),
    ).toBe("error")
  })

  it("gates the flow on Slack authorization first", () => {
    expect(getSlackSetupView({ status: undefined, isPending: false })).toBe(
      "authorize",
    )
    expect(
      getSlackSetupView({
        status: { ...status, isInstalled: false },
        isPending: false,
      }),
    ).toBe("authorize")
  })

  it("gates configuration on a GitHub connection", () => {
    expect(
      getSlackSetupView({
        status: { ...status, isGithubLinked: false },
        isPending: false,
      }),
    ).toBe("github")
  })

  it("asks for a context repository while the connector is still a draft", () => {
    expect(getSlackSetupView({ status, isPending: false })).toBe("target")
  })

  it("shows the capture instructions once the connector is live", () => {
    expect(
      getSlackSetupView({
        status: { ...status, setupPhase: "live" },
        isPending: false,
      }),
    ).toBe("live")
  })

  it("shows a loading state while pending, regardless of status", () => {
    expect(
      getSlackSetupView({
        status: { ...status, setupPhase: "live" },
        isPending: true,
      }),
    ).toBe("loading")
  })
})

describe("getSlackSetupStepIndex", () => {
  it("maps setup prerequisites and phase to a step index", () => {
    expect(getSlackSetupStepIndex(undefined)).toBe(0)
    expect(getSlackSetupStepIndex({ ...status, isGithubLinked: false })).toBe(1)
    expect(getSlackSetupStepIndex(status)).toBe(2)
    expect(getSlackSetupStepIndex({ ...status, setupPhase: "live" })).toBe(3)
  })
})

describe("getSlackSetupPhaseLabel", () => {
  it("uses human-readable connector status labels", () => {
    expect(getSlackSetupPhaseLabel({ setupPhase: "draft" })).toBe(
      "Setup required",
    )
    expect(getSlackSetupPhaseLabel({ setupPhase: "live" })).toBe("Connected")
  })
})
