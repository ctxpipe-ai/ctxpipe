import { describe, expect, it } from "vitest"

import {
  getZendeskCardCtaLabel,
  getZendeskSetupStep,
  getZendeskSetupSteps,
  zendeskUsesLocalClient,
} from "./zendesk-setup-model"

const status = (
  overrides: Partial<{
    status: "pending" | "installed" | "revoked"
    oauthClientConfigured: boolean
    oauthClientId: string | null
    deploymentOAuthClient: boolean
    webhookConfigured: boolean
  }> = {},
) => ({
  status: "installed" as const,
  oauthClientConfigured: true,
  oauthClientId: "ctxpipe-dev" as string | null,
  deploymentOAuthClient: false,
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

describe("zendeskUsesLocalClient", () => {
  it("is true for a saved local client, and false for the deployment client", () => {
    expect(zendeskUsesLocalClient(status())).toBe(true)
    expect(
      zendeskUsesLocalClient(
        status({ deploymentOAuthClient: true, oauthClientId: null }),
      ),
    ).toBe(false)
    // A local client wins over the deployment client.
    expect(
      zendeskUsesLocalClient(status({ deploymentOAuthClient: true })),
    ).toBe(true)
    expect(
      zendeskUsesLocalClient(
        status({ oauthClientConfigured: false, oauthClientId: null }),
      ),
    ).toBe(true)
  })
})

describe("getZendeskSetupStep", () => {
  const notDone = {
    workspacesDone: false,
    reconnect: false,
    changingClient: false,
  }

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

  it("shows the OAuth client step again while the user changes the client", () => {
    for (const overrides of [
      { status: "pending" as const },
      { status: "revoked" as const },
      { status: "installed" as const },
    ])
      expect(
        getZendeskSetupStep(status(overrides), {
          ...notDone,
          reconnect: true,
          changingClient: true,
        }),
      ).toBe("register")
    // Cancel or a save clears the flag, and the connect step comes back.
    expect(getZendeskSetupStep(status({ status: "pending" }), notDone)).toBe(
      "connect",
    )
  })

  it("connects again on a reconnect of a working connection", () => {
    expect(getZendeskSetupStep(status(), { ...notDone, reconnect: true })).toBe(
      "connect",
    )
  })

  it("adds to Workspaces once connected, then is done", () => {
    expect(getZendeskSetupStep(status(), notDone)).toBe("workspaces")
    expect(
      getZendeskSetupStep(status(), { ...notDone, workspacesDone: true }),
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
    // An unfinished setup continues at its own step.
    expect(getZendeskCardCtaLabel(status({ status: "pending" }))).toBe(
      "Connect Zendesk",
    )
  })
})
