import type { networkInterfaces } from "node:os"
import { describe, expect, it } from "vitest"
import { sandboxCallbackHost } from "./workspace-chat-callback.js"

type Interfaces = ReturnType<typeof networkInterfaces>

function entry(address: string, family: "IPv4" | "IPv6", internal = false) {
  return {
    address,
    family,
    internal,
    netmask: family === "IPv4" ? "255.255.255.0" : "ffff:ffff:ffff:ffff::",
    mac: "00:00:00:00:00:00",
    cidr: null,
    ...(family === "IPv6" ? { scopeid: 0 } : {}),
  } as Interfaces[string] extends Array<infer T> | undefined ? T : never
}

const remote = { DOCKER_HOST: "tcp://sandbox-host.ctxpipe.local:2376" }

describe("sandbox callback host for a remote Docker daemon", () => {
  it("uses the one non-loopback IPv4 address of this process", () => {
    const interfaces: Interfaces = {
      lo: [entry("127.0.0.1", "IPv4", true), entry("::1", "IPv6", true)],
      eth1: [entry("10.0.3.17", "IPv4"), entry("fe80::1", "IPv6")],
    }
    expect(sandboxCallbackHost(remote, interfaces)).toBe("10.0.3.17")
  })

  it("fails closed when the address is ambiguous or missing", () => {
    expect(() =>
      sandboxCallbackHost(remote, {
        eth0: [entry("10.0.3.17", "IPv4")],
        eth1: [entry("172.17.0.1", "IPv4")],
      }),
    ).toThrow(/2 non-loopback IPv4 addresses; set SANDBOX_CALLBACK_HOST/)
    expect(() =>
      sandboxCallbackHost(remote, { lo: [entry("127.0.0.1", "IPv4", true)] }),
    ).toThrow(/0 non-loopback IPv4 addresses/)
  })

  it("keeps an explicit host and leaves local daemons on their defaults", () => {
    const interfaces: Interfaces = {
      eth0: [entry("10.0.3.17", "IPv4")],
      eth1: [entry("172.17.0.1", "IPv4")],
    }
    expect(
      sandboxCallbackHost(
        { ...remote, SANDBOX_CALLBACK_HOST: "10.0.9.9" },
        interfaces,
      ),
    ).toBe("10.0.9.9")
    expect(sandboxCallbackHost({}, interfaces)).toBeUndefined()
    expect(
      sandboxCallbackHost(
        { DOCKER_HOST: "unix:///var/run/docker.sock" },
        interfaces,
      ),
    ).toBeUndefined()
  })
})
