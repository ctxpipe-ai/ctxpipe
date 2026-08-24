import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import {
  leaseLocalProcessOpenCodePort,
  waitForListenPortFree,
} from "./workspace-chat-opencode-port.js"

describe("waitForListenPortFree", () => {
  it("resolves when the port is free", async () => {
    await expect(waitForListenPortFree(0)).resolves.toBeUndefined()
  })

  it("waits until a bound port is released", async () => {
    const server = createServer()
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") {
          reject(new Error("expected tcp address"))
          return
        }
        resolve(address.port)
      })
    })
    setTimeout(() => server.close(), 40)
    await expect(waitForListenPortFree(port, 2_000)).resolves.toBeUndefined()
  })
})

describe("leaseLocalProcessOpenCodePort", () => {
  it("leases distinct ports for concurrent conversations", async () => {
    const first = await leaseLocalProcessOpenCodePort()
    const second = await leaseLocalProcessOpenCodePort()
    expect(first.port).not.toBe(second.port)
    expect(first.port).toBeGreaterThan(0)
    await Promise.all([first.release(), second.release()])
  })

  it("does not lease a reserved model-proxy port", async () => {
    const first = await leaseLocalProcessOpenCodePort()
    const second = await leaseLocalProcessOpenCodePort({
      reserved: [first.port],
    })
    expect(second.port).not.toBe(first.port)
    await Promise.all([first.release(), second.release()])
  })
})
