import { describe, expect, it } from "vitest"
import {
  destroyDetachedProviderSandbox,
  detectSandboxProvider,
  detectSandboxProviderFromEnv,
  sandboxMustFailClosed,
} from "./sandbox-provider.js"

describe("detectSandboxProvider", () => {
  it("locks a known provider and fail-closes on an unknown lock", () => {
    expect(detectSandboxProvider({ locked: "railway" })).toBe("railway")
    expect(() => detectSandboxProvider({ locked: "heroku" })).toThrow(
      /Unknown SANDBOX_PROVIDER/,
    )
    expect(detectSandboxProvider({ hasDocker: true })).toBe("docker")
    expect(detectSandboxProvider({})).toBe("unsandboxed")
    expect(
      detectSandboxProviderFromEnv({
        env: { SANDBOX_PROVIDER: "docker" },
      }),
    ).toBe("docker")
    expect(() =>
      detectSandboxProviderFromEnv({
        env: { SANDBOX_PROVIDER: "heroku" },
      }),
    ).toThrow(/Unknown SANDBOX_PROVIDER/)
  })

  it("fails closed when an isolated provider cannot enforce limits", () => {
    expect(
      sandboxMustFailClosed({ provider: "docker", canEnforceLimits: false }),
    ).toBe(true)
    expect(
      sandboxMustFailClosed({
        provider: "unsandboxed",
        canEnforceLimits: false,
      }),
    ).toBe(false)
  })
})

describe("destroyDetachedProviderSandbox", () => {
  it("refuses railway, unsandboxed, and missing providers instead of routing to local-process", async () => {
    await expect(
      destroyDetachedProviderSandbox({
        provider: "railway",
        providerSandboxId: "sbx_1",
      }),
    ).rejects.toThrow(/provider railway/)
    await expect(
      destroyDetachedProviderSandbox({
        provider: "unsandboxed",
        providerSandboxId: "sbx_1",
      }),
    ).rejects.toThrow(/provider unsandboxed/)
    await expect(
      destroyDetachedProviderSandbox({
        provider: null,
        providerSandboxId: "sbx_1",
      }),
    ).rejects.toThrow(/provider unknown/)
  })
})
