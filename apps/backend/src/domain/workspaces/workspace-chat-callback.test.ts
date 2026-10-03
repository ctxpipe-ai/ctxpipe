import { networkInterfaces } from "node:os"
import { describe, expect, it } from "vitest"
import { sandboxCallbackHost } from "./workspace-chat-callback.js"

describe("sandbox callback host for a remote Docker daemon", () => {
  it("uses the address this process reaches the daemon from", async () => {
    // A daemon on one of this machine's own addresses: the kernel routes to
    // it from that address, as a dual-homed Compose backend reaches DinD
    // from its sandbox-network address.
    const addresses = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address)
    expect(addresses.length).toBeGreaterThan(0)
    for (const address of addresses) {
      await expect(
        sandboxCallbackHost({ DOCKER_HOST: `tcp://${address}:2376` }),
      ).resolves.toBe(address)
    }
  })

  it("leaves a daemon on loopback to the provider's local defaults", async () => {
    await expect(
      sandboxCallbackHost({ DOCKER_HOST: "tcp://127.0.0.1:2376" }),
    ).resolves.toBeUndefined()
    await expect(
      sandboxCallbackHost({ DOCKER_HOST: "tcp://localhost:2376" }),
    ).resolves.toBeUndefined()
  })

  it("fails closed when the daemon host does not resolve", async () => {
    await expect(
      sandboxCallbackHost({ DOCKER_HOST: "tcp://sandbox-host.invalid:2376" }),
    ).rejects.toThrow(
      /Cannot resolve Docker host sandbox-host.invalid.*set SANDBOX_CALLBACK_HOST/,
    )
  })

  it("keeps an explicit host and leaves local daemons on their defaults", async () => {
    await expect(
      sandboxCallbackHost({
        DOCKER_HOST: "tcp://sandbox-host.invalid:2376",
        SANDBOX_CALLBACK_HOST: "10.0.9.9",
      }),
    ).resolves.toBe("10.0.9.9")
    await expect(sandboxCallbackHost({})).resolves.toBeUndefined()
    await expect(
      sandboxCallbackHost({ DOCKER_HOST: "unix:///var/run/docker.sock" }),
    ).resolves.toBeUndefined()
  })
})
