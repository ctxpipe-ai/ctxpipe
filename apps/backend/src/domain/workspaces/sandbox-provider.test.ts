import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  destroyDetachedProviderSandbox,
  detectSandboxProvider,
  detectSandboxProviderFromEnv,
} from "./sandbox-provider.js"

const dockerSandbox = vi.hoisted(() => vi.fn())
const dockerPing = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("@tanstack/ai-sandbox-docker", () => ({
  dockerSandbox,
}))

vi.mock("dockerode", () => ({
  default: class Docker {
    ping = dockerPing
  },
}))

describe("detectSandboxProvider", () => {
  it("locks a known provider and fail-closes on an unknown lock", () => {
    expect(detectSandboxProvider({ locked: "vercel", hasDocker: true })).toBe(
      "vercel",
    )
    expect(detectSandboxProvider({ locked: "docker" })).toBe("docker")
    for (const retired of ["sbx", "railway", "heroku"])
      expect(() => detectSandboxProvider({ locked: retired })).toThrow(
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
})

describe("destroyDetachedProviderSandbox", () => {
  beforeEach(() => {
    dockerSandbox.mockReset()
    dockerPing.mockReset()
    dockerPing.mockResolvedValue(undefined)
  })

  it("refuses unknown, unsandboxed, and missing providers instead of routing to local-process", async () => {
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

  it("does not treat a Docker outage as a successful destroy", async () => {
    dockerPing.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const destroy = vi.fn(async () => undefined)
    dockerSandbox.mockReturnValue({ destroy, resume: async () => null })
    await expect(
      destroyDetachedProviderSandbox({
        provider: "docker",
        providerSandboxId: "ctr_1",
      }),
    ).rejects.toThrow("ECONNREFUSED")
    expect(destroy).not.toHaveBeenCalled()
  })
})
