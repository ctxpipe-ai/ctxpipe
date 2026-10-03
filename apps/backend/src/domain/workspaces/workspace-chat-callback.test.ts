import { describe, expect, it } from "vitest"
import {
  type CallbackNetwork,
  sandboxCallbackHost,
} from "./workspace-chat-callback.js"

/** Name resolution and routing for one daemon host; the environment seam. */
function network(routes: {
  hosts: Record<string, { address: string; family: number }>
  sources: Record<string, string | Error>
}): CallbackNetwork {
  return {
    async lookup(host) {
      const target = routes.hosts[host]
      if (!target)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
          code: "ENOTFOUND",
        })
      return target
    },
    async sourceAddress(address) {
      const source = routes.sources[address]
      if (source instanceof Error) throw source
      if (!source) throw new Error(`no route for ${address}`)
      return source
    },
  }
}

const compose = network({
  // Compose: `dind` is on the sandbox network; the backend is also on the app network.
  hosts: { dind: { address: "172.21.0.2", family: 4 } },
  sources: { "172.21.0.2": "172.21.0.3" },
})

describe("sandbox callback host for a remote Docker daemon", () => {
  it("uses the address this process reaches the daemon from", async () => {
    await expect(
      sandboxCallbackHost({ DOCKER_HOST: "tcp://dind:2376" }, compose),
    ).resolves.toBe("172.21.0.3")
    await expect(
      sandboxCallbackHost(
        { DOCKER_HOST: "tcp://[fd00::5]:2376" },
        network({
          hosts: { "fd00::5": { address: "fd00::5", family: 6 } },
          sources: { "fd00::5": "fd00::9" },
        }),
      ),
    ).resolves.toBe("[fd00::9]")
  })

  it("leaves a daemon reached over loopback to the provider's local defaults", async () => {
    for (const source of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      await expect(
        sandboxCallbackHost(
          { DOCKER_HOST: "tcp://localhost:2376" },
          network({
            hosts: { localhost: { address: "127.0.0.1", family: 4 } },
            sources: { "127.0.0.1": source },
          }),
        ),
      ).resolves.toBeUndefined()
    }
  })

  it("reports a sandbox host that does not resolve or route yet", async () => {
    const unresolved = sandboxCallbackHost(
      { DOCKER_HOST: "tcp://sandbox-host.ctxpipe.local:2376" },
      compose,
    )
    await expect(unresolved).rejects.toThrow(
      "The sandbox host sandbox-host.ctxpipe.local is not reachable yet",
    )
    await expect(unresolved).rejects.toHaveProperty("cause.code", "ENOTFOUND")
    const unrouted = sandboxCallbackHost(
      { DOCKER_HOST: "tcp://dind:2376" },
      network({
        hosts: { dind: { address: "172.21.0.2", family: 4 } },
        sources: {
          "172.21.0.2": Object.assign(new Error("connect ENETUNREACH"), {
            code: "ENETUNREACH",
          }),
        },
      }),
    )
    await expect(unrouted).rejects.toThrow("is not reachable yet")
    await expect(unrouted).rejects.toHaveProperty("cause.code", "ENETUNREACH")
  })

  it("keeps an explicit host and leaves local daemons on their defaults", async () => {
    await expect(
      sandboxCallbackHost(
        { DOCKER_HOST: "tcp://dind:2376", SANDBOX_CALLBACK_HOST: "10.0.9.9" },
        compose,
      ),
    ).resolves.toBe("10.0.9.9")
    await expect(sandboxCallbackHost({}, compose)).resolves.toBeUndefined()
    await expect(
      sandboxCallbackHost(
        { DOCKER_HOST: "unix:///var/run/docker.sock" },
        compose,
      ),
    ).resolves.toBeUndefined()
  })
})
