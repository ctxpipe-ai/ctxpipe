import { describe, expect, it } from "vitest"
import {
  getBuildkiteCardCtaLabel,
  getBuildkiteSetupStep,
} from "./buildkite-setup-model"

const installed = { status: "installed" as const, webhookConfigured: true }
const noProgress = { webhookSkipped: false, workspacesDone: false }

describe("getBuildkiteSetupStep", () => {
  it("starts at connect without a connection, and after a revoke", () => {
    expect(getBuildkiteSetupStep(undefined, noProgress)).toBe("connect")
    expect(
      getBuildkiteSetupStep({ ...installed, status: "revoked" }, noProgress),
    ).toBe("connect")
  })

  it("asks for the webhook until it is saved or skipped", () => {
    const noWebhook = { ...installed, webhookConfigured: false }
    expect(getBuildkiteSetupStep(noWebhook, noProgress)).toBe("webhook")
    expect(
      getBuildkiteSetupStep(noWebhook, { ...noProgress, webhookSkipped: true }),
    ).toBe("workspaces")
    expect(getBuildkiteSetupStep(installed, noProgress)).toBe("workspaces")
  })

  it("is done after the Workspaces step", () => {
    expect(
      getBuildkiteSetupStep(installed, { ...noProgress, workspacesDone: true }),
    ).toBe("done")
  })
})

describe("getBuildkiteCardCtaLabel", () => {
  it("asks for a reconnect, then for the webhook, then for nothing", () => {
    expect(getBuildkiteCardCtaLabel({ ...installed, status: "revoked" })).toBe(
      "Reconnect Buildkite",
    )
    expect(
      getBuildkiteCardCtaLabel({ ...installed, webhookConfigured: false }),
    ).toBe("Add the webhook")
    expect(getBuildkiteCardCtaLabel(installed)).toBeNull()
  })
})
