import { describe, expect, it, vi } from "vitest"

const provisionMock = vi.hoisted(() =>
  vi.fn(async () => ({
    name: "tanstack",
    url: "http://host.docker.internal:4123/mcp",
    token: "tok",
    close: vi.fn(async () => {}),
  })),
)

vi.mock("@tanstack/ai-sandbox", () => ({
  nodeHttpBridgeProvisioner: { provision: provisionMock },
}))

import {
  provisionWorkspaceChatToolBridge,
  workspaceChatToolBridgeServeEnv,
} from "./workspace-chat-tool-bridge.js"
import type { WorkspaceChatTanstackTool } from "./workspace-chat-tools.js"

const hybridSearch: WorkspaceChatTanstackTool = {
  name: "hybrid_search",
  description: "Search the projection",
  inputSchema: { type: "object", properties: {} },
  execute: async () => ({}),
}

describe("workspace chat tool bridge", () => {
  it("skips provision when there are no tools", async () => {
    await expect(
      provisionWorkspaceChatToolBridge({
        tools: [],
        isolation: "docker",
      }),
    ).resolves.toBeNull()
    expect(provisionMock).not.toHaveBeenCalled()
  })

  it("provisions TanStack tools for a docker sandbox", async () => {
    const bridge = await provisionWorkspaceChatToolBridge({
      tools: [hybridSearch],
      isolation: "docker",
    })
    expect(provisionMock).toHaveBeenCalledWith(
      [hybridSearch],
      { provider: "docker" },
    )
    expect(bridge).toEqual(
      expect.objectContaining({
        name: "tanstack",
        url: "http://host.docker.internal:4123/mcp",
      }),
    )
    expect(workspaceChatToolBridgeServeEnv(bridge!)).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        mcp: {
          tanstack: {
            type: "remote",
            url: "http://host.docker.internal:4123/mcp",
            enabled: true,
            headers: { Authorization: "Bearer tok" },
          },
        },
      }),
    })
  })
})
