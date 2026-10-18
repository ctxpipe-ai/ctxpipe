import { request } from "node:http"
import { createServer, type Server } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
  connectionTimeoutError,
  expectRefusal,
  retryOnConnectionError,
} from "./retryOnConnectionError.js"

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function resetFirstConnection() {
  let connections = 0
  server = createServer((socket) => {
    connections += 1
    if (connections === 1) {
      socket.resetAndDestroy()
      return
    }
    socket.end(
      "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
    )
  })
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const get = () =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port }, (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode ?? 0))
      })
      req.on("error", reject)
      req.end()
    })
  return { get, count: () => connections }
}

describe("retryOnConnectionError", () => {
  it("fails on a reset connection without the retry", async () => {
    const { get } = await resetFirstConnection()
    await expect(get()).rejects.toMatchObject({ code: "ECONNRESET" })
  })

  it("succeeds when only the first connection is reset", async () => {
    const { get, count } = await resetFirstConnection()
    await expect(retryOnConnectionError(get, { delayMs: 1 })).resolves.toBe(200)
    expect(count()).toBe(2)
  })

  it("stops at once on an error that is not a connection error", async () => {
    let calls = 0
    await expect(
      retryOnConnectionError(
        async () => {
          calls += 1
          throw new Error("bad pin")
        },
        { delayMs: 1 },
      ),
    ).rejects.toThrow("bad pin")
    expect(calls).toBe(1)
  })

  it("gives up after the bounded number of attempts", async () => {
    let calls = 0
    await expect(
      retryOnConnectionError(
        async () => {
          calls += 1
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" })
        },
        { attempts: 3, delayMs: 1 },
      ),
    ).rejects.toThrow("reset")
    expect(calls).toBe(3)
  })
})

// The first connection stays silent, so the probe times out. Later ones answer.
async function silentServer(silent: "first" | "all") {
  let connections = 0
  server = createServer((socket) => {
    connections += 1
    if (silent === "all" || connections === 1) return
    socket.end(
      "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
    )
  })
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const probe = () =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port }, (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode ?? 0))
      })
      req.setTimeout(50, () =>
        req.destroy(connectionTimeoutError("Timed out verifying probe")),
      )
      req.on("error", reject)
      req.end()
    })
  const open = (onResponse: () => void) =>
    request({ host: "127.0.0.1", port }, onResponse)
  return { probe, open, count: () => connections }
}

describe("retryOnConnectionError with a probe timeout", () => {
  it("passes when the probe times out once and then succeeds", async () => {
    const { probe, count } = await silentServer("first")
    await expect(retryOnConnectionError(probe, { delayMs: 1 })).resolves.toBe(
      200,
    )
    expect(count()).toBe(2)
  })

  it("still fails when every attempt times out", async () => {
    const { probe, count } = await silentServer("all")
    await expect(
      retryOnConnectionError(probe, { attempts: 3, delayMs: 1 }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" })
    expect(count()).toBe(3)
  })
})

describe("expectRefusal", () => {
  it("fails with ETIMEDOUT when the probe host stays silent", async () => {
    const { open } = await silentServer("all")
    await expect(
      expectRefusal(open, { timeoutMs: 50, message: "Timed out" }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" })
  })

  it("fails after the last attempt when the host stays silent", async () => {
    const { open, count } = await silentServer("all")
    await expect(
      retryOnConnectionError(
        () => expectRefusal(open, { timeoutMs: 50, message: "Timed out" }),
        { attempts: 3, delayMs: 1 },
      ),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" })
    expect(count()).toBe(3)
  })

  it("passes on a refusal", async () => {
    server = createServer((socket) => socket.resetAndDestroy())
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    )
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    await expect(
      expectRefusal(
        (onResponse) => request({ host: "127.0.0.1", port }, onResponse),
        {
          timeoutMs: 1_000,
          message: "Timed out",
        },
      ),
    ).resolves.toBeUndefined()
  })

  it("fails when the host answers", async () => {
    const { open } = await silentServer("first")
    // The first connection is silent, so use a second probe that gets an answer.
    await expect(
      expectRefusal(open, { timeoutMs: 50, message: "t" }),
    ).rejects.toBeDefined()
    await expect(
      expectRefusal(open, { timeoutMs: 1_000, message: "t" }),
    ).rejects.toThrow("ignored the callback-selected pinned address")
  })
})
