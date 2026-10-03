import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  destroyDetachedProviderSandbox,
  lockedSandboxProvider,
  remoteDockerHost,
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

describe("lockedSandboxProvider", () => {
  it("locks a known provider and fail-closes on an unknown lock", () => {
    expect(lockedSandboxProvider({ SANDBOX_PROVIDER: "vercel" })).toBe("vercel")
    expect(lockedSandboxProvider({ SANDBOX_PROVIDER: " docker " })).toBe(
      "docker",
    )
    expect(lockedSandboxProvider({})).toBeUndefined()
    for (const retired of ["sbx", "railway", "heroku"])
      expect(() =>
        lockedSandboxProvider({ SANDBOX_PROVIDER: retired }),
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

describe("remoteDockerHost", () => {
  it("names a TCP daemon's host and nothing for the local socket", () => {
    expect(
      remoteDockerHost({
        DOCKER_HOST: "tcp://sandbox-host.ctxpipe.local:2376",
      }),
    ).toBe("sandbox-host.ctxpipe.local")
    expect(remoteDockerHost({ DOCKER_HOST: "dind:2376" })).toBe("dind")
    expect(remoteDockerHost({ DOCKER_HOST: "tcp://[fd00::5]:2376" })).toBe(
      "[fd00::5]",
    )
    expect(
      remoteDockerHost({ DOCKER_HOST: "unix:///var/run/docker.sock" }),
    ).toBeUndefined()
    expect(remoteDockerHost({})).toBeUndefined()
  })
})
