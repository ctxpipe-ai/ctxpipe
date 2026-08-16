import { describe, expect, it } from "vitest"
import {
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
