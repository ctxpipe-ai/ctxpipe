import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import {
  waitForListenPortFree,
  withLocalProcessOpenCodePort,
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

describe("withLocalProcessOpenCodePort", () => {
  it("runs callbacks in series", async () => {
    const order: number[] = []
    const slow = withLocalProcessOpenCodePort(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push(1)
    })
    const fast = withLocalProcessOpenCodePort(async () => {
      order.push(2)
    })
    await Promise.all([slow, fast])
    expect(order).toEqual([1, 2])
  })
})
