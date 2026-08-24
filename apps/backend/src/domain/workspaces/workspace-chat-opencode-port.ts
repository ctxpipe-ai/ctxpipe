import { createServer } from "node:http"

const leasedPorts = new Set<number>()

export type LocalProcessOpenCodePortLease = {
  port: number
  release: () => Promise<void>
}

export async function leaseLocalProcessOpenCodePort(input?: {
  reserved?: Iterable<number>
}): Promise<LocalProcessOpenCodePortLease> {
  const reserved = new Set(input?.reserved ?? [])
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = await bindEphemeralPort()
    if (leasedPorts.has(port) || reserved.has(port)) continue
    leasedPorts.add(port)
    return {
      port,
      release: async () => {
        try {
          await waitForListenPortFree(port)
        } finally {
          leasedPorts.delete(port)
        }
      },
    }
  }
  throw new Error("Could not lease a free local-process OpenCode port")
}

export async function waitForListenPortFree(
  port: number,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    const free = await tryListen(port)
    if (free) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`port ${port} still bound after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function bindEphemeralPort(): Promise<number> {
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("expected tcp address"))
        return
      }
      resolve(address.port)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return port
}

function tryListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true))
    })
  })
}
