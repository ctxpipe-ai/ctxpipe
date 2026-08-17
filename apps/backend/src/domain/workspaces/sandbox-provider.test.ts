import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  destroyDetachedProviderSandbox,
  detectSandboxProvider,
  detectSandboxProviderFromEnv,
  sandboxMustFailClosed,
} from "./sandbox-provider.js"

const dockerSandbox = vi.hoisted(() => vi.fn())
const sbxSandbox = vi.hoisted(() => vi.fn())
const dockerPing = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("@tanstack/ai-sandbox-docker", () => ({
  dockerSandbox,
  sbxSandbox,
}))

vi.mock("dockerode", () => ({
  default: class Docker {
    ping = dockerPing
  },
}))

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
  beforeEach(() => {
    dockerSandbox.mockReset()
    sbxSandbox.mockReset()
    dockerPing.mockReset()
    dockerPing.mockResolvedValue(undefined)
  })

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

  it("destroys sbx through sbxSandbox instead of dockerSandbox", async () => {
    const destroy = vi.fn(async () => undefined)
    const resume = vi.fn(async () => null)
    sbxSandbox.mockReturnValue({ destroy, resume })
    await destroyDetachedProviderSandbox({
      provider: "sbx",
      providerSandboxId: "sbx_vm",
    })
    expect(sbxSandbox).toHaveBeenCalled()
    expect(dockerSandbox).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledWith({ id: "sbx_vm" })
    expect(resume).toHaveBeenCalledWith({ id: "sbx_vm" })
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
