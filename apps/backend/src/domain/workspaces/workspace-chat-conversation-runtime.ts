import { CHAT_SANDBOX_KEEP_ALIVE } from "./chat-runtime.js"
import type { WorkspaceChatModelProxy } from "./workspace-chat-model-proxy.js"
import type { LocalProcessOpenCodePortLease } from "./workspace-chat-opencode-port.js"
import type { WorkspaceChatToolBridge } from "./workspace-chat-tool-bridge.js"
import type { WorkspaceChatTanstackTool } from "./workspace-chat-tools.js"

const KEEP_ALIVE_MS = parseKeepAliveMs(CHAT_SANDBOX_KEEP_ALIVE)

export type WorkspaceChatOpenCodeServe = {
  baseUrl: string
  headers?: Record<string, string>
  dispose: () => Promise<void>
}

export type WorkspaceChatConversationWorkspace = {
  orgId: string
  workspaceId: string
  desiredUrl: string
  desiredSha: string | null
  desiredGeneration?: number
  writeStatus: string
  defaultBranch?: string
  lastBranch?: string | null
  cloneToken?: string | null
}

export type WorkspaceChatConversationRuntime = {
  conversationId: string
  runToken: string
  proxy: WorkspaceChatModelProxy
  proxyLease: LocalProcessOpenCodePortLease | null
  servePort: number
  servePortLease: LocalProcessOpenCodePortLease | null
  tools: WorkspaceChatTanstackTool[]
  toolBridge?: WorkspaceChatToolBridge | null
  sessionId?: string | null
  serve: WorkspaceChatOpenCodeServe | null
  workspace?: WorkspaceChatConversationWorkspace
  lastUsedAt: number
}

const runtimes = new Map<string, WorkspaceChatConversationRuntime>()

export function getWorkspaceChatConversationRuntime(
  conversationId: string,
): WorkspaceChatConversationRuntime | null {
  const runtime = runtimes.get(conversationId)
  if (!runtime) return null
  if (Date.now() - runtime.lastUsedAt > KEEP_ALIVE_MS) {
    void releaseWorkspaceChatConversationRuntime(conversationId)
    return null
  }
  runtime.lastUsedAt = Date.now()
  return runtime
}

export function setWorkspaceChatConversationRuntime(
  runtime: Omit<WorkspaceChatConversationRuntime, "lastUsedAt"> & {
    lastUsedAt?: number
  },
): WorkspaceChatConversationRuntime {
  const next: WorkspaceChatConversationRuntime = {
    ...runtime,
    lastUsedAt: runtime.lastUsedAt ?? Date.now(),
  }
  runtimes.set(next.conversationId, next)
  return next
}

export async function releaseWorkspaceChatConversationRuntime(
  conversationId: string,
): Promise<void> {
  const runtime = runtimes.get(conversationId)
  if (!runtime) return
  runtimes.delete(conversationId)
  await runtime.serve?.dispose().catch(() => undefined)
  await runtime.toolBridge?.close().catch(() => undefined)
  await runtime.proxy.close().catch(() => undefined)
  await runtime.proxyLease?.release().catch(() => undefined)
  await runtime.servePortLease?.release().catch(() => undefined)
}

export function resetWorkspaceChatConversationRuntimes(): void {
  runtimes.clear()
}

function parseKeepAliveMs(value: string): number {
  const match = /^(\d+)m$/.exec(value)
  if (!match) return 30 * 60 * 1000
  return Number(match[1]) * 60 * 1000
}
