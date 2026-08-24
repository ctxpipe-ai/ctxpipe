import type { AnyTool } from "@tanstack/ai"
import { nodeHttpBridgeProvisioner } from "@tanstack/ai-sandbox"
import { log } from "../../observability/logger.js"
import type { WorkspaceChatTanstackTool } from "./workspace-chat-tools.js"

export type WorkspaceChatToolBridge = {
  name: string
  url: string
  token: string
  close: () => Promise<void>
}

export async function provisionWorkspaceChatToolBridge(input: {
  tools: WorkspaceChatTanstackTool[]
  isolation: "docker" | "local_process"
}): Promise<WorkspaceChatToolBridge | null> {
  if (input.tools.length === 0) return null
  try {
    return await nodeHttpBridgeProvisioner.provision(
      input.tools as unknown as AnyTool[],
      {
        provider: input.isolation === "docker" ? "docker" : "local_process",
      },
    )
  } catch (error) {
    log.warn({
      step: "workspace-chat-tool-bridge",
      message: "workspace chat tool bridge provision failed",
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export function workspaceChatToolBridgeServeEnv(
  bridge: WorkspaceChatToolBridge,
): Record<string, string> {
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      mcp: {
        [bridge.name]: {
          type: "remote",
          url: bridge.url,
          enabled: true,
          headers: { Authorization: `Bearer ${bridge.token}` },
        },
      },
    }),
  }
}
