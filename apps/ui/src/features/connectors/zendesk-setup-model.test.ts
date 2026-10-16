import { describe, expect, it } from "vitest"
import {
  getZendeskCardCtaLabel,
  getZendeskSetupStep,
  getZendeskSetupSteps,
} from "./zendesk-setup-model"

const status = (
  overrides: Partial<{
    status: "pending" | "installed" | "revoked"
    oauthClientConfigured: boolean
    webhookConfigured: boolean
  }> = {},
) => ({
  status: "installed" as const,
  oauthClientConfigured: true,
  webhookConfigured: true,
  ...overrides,
})

describe("getZendeskSetupSteps", () => {
  it("adds the OAuth client step only on a deployment without one", () => {
    expect(getZendeskSetupSteps(true).map((step) => step.id)).toEqual([
      "account",
      "connect",
      "workspaces",
    ])
    expect(getZendeskSetupSteps(false).map((step) => step.id)).toEqual([
      "account",
      "register",
      "connect",
      "workspaces",
    ])
  })
})

describe("getZendeskSetupStep", () => {
  const notDone = { workspacesDone: false, reconnect: false }

  it("starts at the account without a connection", () => {
    expect(getZendeskSetupStep(undefined, notDone)).toBe("account")
  })

  it("asks for an OAuth client before OAuth, then connects", () => {
    expect(
      getZendeskSetupStep(
        status({ status: "pending", oauthClientConfigured: false }),
        notDone,
      ),
    ).toBe("register")
    expect(getZendeskSetupStep(status({ status: "pending" }), notDone)).toBe(
      "connect",
    )
    expect(getZendeskSetupStep(status({ status: "revoked" }), notDone)).toBe(
      "connect",
    )
  })

  it("connects again on a reconnect of a working connection", () => {
    expect(
      getZendeskSetupStep(status(), { workspacesDone: false, reconnect: true }),
    ).toBe("connect")
  })

  it("adds to Workspaces once connected, then is done", () => {
    expect(getZendeskSetupStep(status(), notDone)).toBe("workspaces")
    expect(
      getZendeskSetupStep(status(), { workspacesDone: true, reconnect: false }),
    ).toBe("done")
  })
})

describe("getZendeskCardCtaLabel", () => {
  it("asks for a reconnect after a revoke, and for the webhook when it is missing", () => {
    expect(getZendeskCardCtaLabel(status({ status: "revoked" }))).toBe(
      "Reconnect Zendesk",
    )
    expect(getZendeskCardCtaLabel(status({ webhookConfigured: false }))).toBe(
      "Add the webhook",
    )
    // As on the other cards: Manage opens the Workspaces step.
    expect(getZendeskCardCtaLabel(status())).toBe("Manage")
  })
})
