import { describe, expect, it } from "vitest"

import {
  getBuildkiteCardCtaLabel,
  getBuildkiteSetupStep,
} from "./buildkite-setup-model"

const installed = { status: "installed" as const, webhookConfigured: true }
const noProgress = { workspacesDone: false, replaceWebhook: false }

describe("getBuildkiteSetupStep", () => {
  it("starts at connect without a connection, and after a revoke", () => {
    expect(getBuildkiteSetupStep(undefined, noProgress)).toBe("connect")
    expect(
      getBuildkiteSetupStep({ ...installed, status: "revoked" }, noProgress),
    ).toBe("connect")
  })

  it("asks for the webhook until it is saved; there is no skip", () => {
    const noWebhook = { ...installed, webhookConfigured: false }
    expect(getBuildkiteSetupStep(noWebhook, noProgress)).toBe("webhook")
    expect(getBuildkiteSetupStep(installed, noProgress)).toBe("workspaces")
  })

  it("asks for the webhook again when the admin replaces its token", () => {
    expect(
      getBuildkiteSetupStep(installed, { ...noProgress, replaceWebhook: true }),
    ).toBe("webhook")
  })

  it("is done after the Workspaces step", () => {
    expect(
      getBuildkiteSetupStep(installed, { ...noProgress, workspacesDone: true }),
    ).toBe("done")
  })
})

describe("getBuildkiteCardCtaLabel", () => {
  it("asks for a reconnect, then for the webhook, then offers Manage", () => {
    expect(getBuildkiteCardCtaLabel({ ...installed, status: "revoked" })).toBe(
      "Reconnect Buildkite",
    )
    expect(
      getBuildkiteCardCtaLabel({ ...installed, webhookConfigured: false }),
    ).toBe("Add the webhook")
    // As on the other cards: Manage opens the Workspaces step.
    expect(getBuildkiteCardCtaLabel(installed)).toBe("Manage")
  })
})
