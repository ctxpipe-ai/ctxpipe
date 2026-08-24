import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import {
  isViteHmrWebSocketRequest,
  proxyUiRequest,
  UI_PROXY_TIMEOUT_MS,
} from "./ui.js"

describe("UI websocket proxy helpers", () => {
  it("detects vite websocket upgrades in development", () => {
    const request = new Request("http://localhost:3000/", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "vite-hmr",
      },
    })

    expect(isViteHmrWebSocketRequest(request, "development")).toBe(true)
  })

  it("detects vite ping websocket upgrades in development", () => {
    const request = new Request("http://localhost:3000/", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "vite-ping",
      },
    })

    expect(isViteHmrWebSocketRequest(request, "development")).toBe(true)
  })

  it("ignores non-vite websocket upgrades", () => {
    const request = new Request("http://localhost:3000/ws", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "graphql-ws",
      },
    })

    expect(isViteHmrWebSocketRequest(request, "development")).toBe(false)
  })

  it("ignores websocket upgrades outside development", () => {
    const request = new Request("http://localhost:3000/", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "vite-hmr",
      },
    })

    expect(isViteHmrWebSocketRequest(request, "production")).toBe(false)
  })
})

describe("UI HTTP proxy budget", () => {
  it("returns 504 when the upstream hangs past the abort budget", async () => {
    expect(UI_PROXY_TIMEOUT_MS).toBe(15_000)

    const server = createServer(() => {
      // Intentionally never respond so the proxy abort budget fires.
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      throw new Error("expected a TCP listen address")
    }

    const started = Date.now()
    try {
      const response = await proxyUiRequest(
        new Request("http://localhost/ws/context"),
        `http://127.0.0.1:${address.port}`,
        50,
      )
      expect(response.status).toBe(504)
      expect(Date.now() - started).toBeLessThan(15_000)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
