import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import {
  isViteHmrWebSocketRequest,
  proxyUiRequest,
  UI_PROXY_TIMEOUT_MS,
  uiProxyUpstreamHeaders,
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
  const trust = { publicOrigin: "http://localhost:3000" }
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
        trust,
      )
      expect(response.status).toBe(504)
      expect(Date.now() - started).toBeLessThan(15_000)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it("returns 502 when the upstream connection is refused", async () => {
    const response = await proxyUiRequest(
      new Request("http://localhost/ws/context"),
      "http://127.0.0.1:1",
      200,
      trust,
    )
    expect(response.status).toBe(502)
    expect(await response.text()).toBe("Bad Gateway")
  })

  it("returns 502 when the upstream resets the connection", async () => {
    const server = createServer((req) => {
      req.socket.destroy()
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      throw new Error("expected a TCP listen address")
    }

    try {
      const response = await proxyUiRequest(
        new Request("http://localhost/ws/context"),
        `http://127.0.0.1:${address.port}`,
        200,
        trust,
      )
      expect(response.status).toBe(502)
      expect(await response.text()).toBe("Bad Gateway")
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})

describe("uiProxyUpstreamHeaders", () => {
  it("replaces a spoofed forwarded host with the configured public host", () => {
    const headers = uiProxyUpstreamHeaders(
      new Headers({
        origin: "https://backend-pr-343.up.railway.app",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      }),
      "ui.railway.internal:3002",
      { publicOrigin: "https://backend-pr-343.up.railway.app" },
    )
    expect(headers.get("x-forwarded-host")).toBe(
      "backend-pr-343.up.railway.app",
    )
    expect(headers.get("x-forwarded-proto")).toBe("https")
    expect(headers.get("host")).toBe("ui.railway.internal:3002")
    expect(headers.get("origin")).toBe("https://backend-pr-343.up.railway.app")
  })

  it("uses the configured https origin without an Origin header", () => {
    const headers = uiProxyUpstreamHeaders(
      new Headers({ "x-forwarded-proto": "https" }),
      "ui.railway.internal:3002",
      { publicOrigin: "https://backend-pr-343.up.railway.app" },
    )
    expect(headers.get("x-forwarded-host")).toBe(
      "backend-pr-343.up.railway.app",
    )
    expect(headers.get("x-forwarded-proto")).toBe("https")
  })
})

describe("browser OTLP proxy headers", () => {
  const publicOrigin = "https://backend-pr-280.up.railway.app"
  const trust = { publicOrigin }

  it("does not trust a forged origin or forwarded host", () => {
    const headers = uiProxyUpstreamHeaders(
      new Headers({
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      }),
      "ui.railway.internal:3002",
      trust,
    )
    expect(headers.get("origin")).toBe("https://evil.example")
    expect(headers.get("x-forwarded-host")).toBe(
      "backend-pr-280.up.railway.app",
    )
    expect(headers.get("x-forwarded-proto")).toBe("https")
  })
})
