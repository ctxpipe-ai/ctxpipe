import { describe, expect, it } from "vitest"
import { isViteHmrWebSocketRequest, uiProxyUpstreamHeaders } from "./ui.js"

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

describe("uiProxyUpstreamHeaders", () => {
  it("replaces a spoofed forwarded host with the request host", () => {
    const headers = uiProxyUpstreamHeaders(
      new URL("https://backend-pr-343.up.railway.app/.otel/v1/traces"),
      new Headers({
        origin: "https://backend-pr-343.up.railway.app",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      }),
      "ui.railway.internal:3002",
    )
    expect(headers.get("x-forwarded-host")).toBe(
      "backend-pr-343.up.railway.app",
    )
    expect(headers.get("x-forwarded-proto")).toBe("https")
    expect(headers.get("host")).toBe("ui.railway.internal:3002")
    expect(headers.get("origin")).toBe("https://backend-pr-343.up.railway.app")
  })

  it("keeps https from the edge when the backend request URL is http", () => {
    const headers = uiProxyUpstreamHeaders(
      new URL("http://backend-pr-343.up.railway.app/.otel/v1/traces"),
      new Headers({ "x-forwarded-proto": "https" }),
      "ui.railway.internal:3002",
    )
    expect(headers.get("x-forwarded-host")).toBe(
      "backend-pr-343.up.railway.app",
    )
    expect(headers.get("x-forwarded-proto")).toBe("https")
  })
})
