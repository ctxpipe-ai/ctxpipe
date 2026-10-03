import { createServer } from "node:net"
import type { AnyTool } from "@tanstack/ai"
import { describe, expect, it } from "vitest"
import {
  sandboxCallbackHost,
  workspaceChatToolBridgeProvisioner,
} from "./workspace-chat-callback.js"

describe("workspace chat callback routing", () => {
  it("accepts bare hosts and rejects URLs or ports", () => {
    expect(sandboxCallbackHost({ SANDBOX_CALLBACK_HOST: "10.0.0.8" })).toBe(
      "10.0.0.8",
    )
    expect(
      sandboxCallbackHost({ SANDBOX_CALLBACK_HOST: "backend.internal" }),
    ).toBe("backend.internal")
    expect(sandboxCallbackHost({ SANDBOX_CALLBACK_HOST: "::1" })).toBe("[::1]")
    expect(() =>
      sandboxCallbackHost({ SANDBOX_CALLBACK_HOST: "backend.internal:80" }),
    ).toThrow("hostname or IP address")
    expect(() =>
      sandboxCallbackHost({
        SANDBOX_CALLBACK_HOST: "https://backend.internal",
      }),
    ).toThrow("hostname or IP address")
  })

  it("serves a bearer-authenticated native bridge and releases its listener", async () => {
    const tool: AnyTool = {
      name: "echo_callback",
      description: "Return the supplied callback value",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      execute(args) {
        return { echoed: args.value }
      },
    }
    const bridge = await workspaceChatToolBridgeProvisioner(
      "127.0.0.1",
    ).provision([tool], { provider: "docker" })
    let bridgeClosed = false

    try {
      const unauthorized = await fetch(bridge.url, { method: "POST" })
      expect(unauthorized.status).toBe(401)
      await unauthorized.text()

      const response = await fetch(bridge.url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo_callback", arguments: { value: "reachable" } },
        }),
      })
      expect(response.status).toBe(200)
      const event = (await response.text())
        .split("\n")
        .find((line) => line.startsWith("data: "))
      expect(event).toBeDefined()
      expect(JSON.parse(event?.slice(6) ?? "null")).toMatchObject({
        result: {
          content: [{ type: "text", text: '{"echoed":"reachable"}' }],
        },
      })

      const endpoint = new URL(bridge.url)
      await bridge.close()
      bridgeClosed = true

      const replacement = createServer()
      await new Promise<void>((resolve, reject) => {
        replacement.once("error", reject)
        replacement.listen(Number(endpoint.port), endpoint.hostname, resolve)
      })
      await new Promise<void>((resolve) => replacement.close(() => resolve()))
    } finally {
      if (!bridgeClosed) await bridge.close()
    }
  })
})
