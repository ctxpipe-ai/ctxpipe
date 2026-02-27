import { describe, expect, it } from "vitest"
import { isViteHmrWebSocketRequest } from "./ui.js"

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
