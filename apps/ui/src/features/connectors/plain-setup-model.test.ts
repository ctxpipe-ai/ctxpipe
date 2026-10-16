import { describe, expect, it } from "vitest"
import { getPlainCardCtaLabel, getPlainSetupStep } from "./plain-setup-model"

const status = (
  overrides: Partial<{
    status: "installed" | "revoked"
    webhookConfigured: boolean
  }> = {},
) => ({
  status: "installed" as const,
  webhookConfigured: true,
  ...overrides,
})

describe("getPlainSetupStep", () => {
  const notDone = { workspacesDone: false, reconnect: false }

  it("starts at the key without a connection, or with a refused key", () => {
    expect(getPlainSetupStep(undefined, notDone)).toBe("connect")
    expect(getPlainSetupStep(status({ status: "revoked" }), notDone)).toBe(
      "connect",
    )
  })

  it("goes to the Workspaces after a connect, then ends", () => {
    expect(getPlainSetupStep(status(), notDone)).toBe("workspaces")
    expect(
      getPlainSetupStep(status(), { ...notDone, workspacesDone: true }),
    ).toBe("done")
  })

  it("asks for the key again on a reconnect", () => {
    expect(getPlainSetupStep(status(), { ...notDone, reconnect: true })).toBe(
      "connect",
    )
  })
})

describe("getPlainCardCtaLabel", () => {
  it("offers a reconnect for a refused key or a missing webhook", () => {
    expect(getPlainCardCtaLabel(status({ status: "revoked" }))).toBe(
      "Reconnect Plain",
    )
    expect(getPlainCardCtaLabel(status({ webhookConfigured: false }))).toBe(
      "Reconnect Plain",
    )
    // As on the other cards: Manage opens the Workspaces step.
    expect(getPlainCardCtaLabel(status())).toBe("Manage")
  })
})
