import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { initLogger } from "evlog"
import { afterEach, describe, expect, it, vi } from "vitest"
import { discoverSandboxProvider } from "./sandbox-provider.js"

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as AddressInfo).port
}

/** A TCP port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

afterEach(() => {
  vi.unstubAllEnvs()
  initLogger({ enabled: false })
})

describe("sandbox provider selection (real Docker client)", () => {
  it("fails closed when the configured daemon is unreachable, never unsandboxed", async () => {
    vi.stubEnv("DOCKER_HOST", `tcp://127.0.0.1:${await closedPort()}`)
    for (const locked of ["", "docker"]) {
      vi.stubEnv("SANDBOX_PROVIDER", locked)
      const failure = discoverSandboxProvider()
      await expect(failure).rejects.toThrow(
        /Docker daemon at tcp:\/\/127\.0\.0\.1:\d+ is not reachable/,
      )
      await expect(failure).rejects.toHaveProperty("cause")
    }
  })

  it("selects Docker when the daemon answers", async () => {
    const daemon = createServer((req, res) => {
      res.writeHead(req.url === "/_ping" ? 200 : 404)
      res.end("OK")
    })
    const port = await listen(daemon)
    try {
      vi.stubEnv("DOCKER_HOST", `tcp://127.0.0.1:${port}`)
      vi.stubEnv("SANDBOX_PROVIDER", "")
      await expect(discoverSandboxProvider()).resolves.toBe("docker")
    } finally {
      await new Promise<void>((resolve) => daemon.close(() => resolve()))
    }
  })

  it("runs unsandboxed only when locked, warning once", async () => {
    const events: Record<string, unknown>[] = []
    initLogger({
      pretty: false,
      silent: true,
      drain: (ctx) => {
        for (const item of Array.isArray(ctx) ? ctx : [ctx])
          events.push(item.event as Record<string, unknown>)
      },
    })
    vi.stubEnv("DOCKER_HOST", `tcp://127.0.0.1:${await closedPort()}`)
    vi.stubEnv("SANDBOX_PROVIDER", "unsandboxed")
    await expect(discoverSandboxProvider()).resolves.toBe("unsandboxed")
    await expect(discoverSandboxProvider()).resolves.toBe("unsandboxed")
    const warnings = events.filter(
      (event) =>
        event.level === "warn" &&
        String(event.message).startsWith("SANDBOX_PROVIDER=unsandboxed"),
    )
    expect(warnings).toHaveLength(1)
  })
})
