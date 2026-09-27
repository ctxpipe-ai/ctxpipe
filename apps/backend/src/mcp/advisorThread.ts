import slugify from "@sindresorhus/slugify"
import type { McpActor } from "../auth/context.js"

/** Non-empty client conversationId; blank or non-string values mean "new thread". */
export function mcpClientConversationId(
  conversationId: unknown,
): string | undefined {
  if (typeof conversationId !== "string") return undefined
  if (conversationId.trim().length === 0) return undefined
  return conversationId
}

/**
 * Persisted MCP thread id (DB row, chat, Langfuse sessionId, telemetry).
 * Shipped formula: `${orgId}_${actorKey}_${slugify(project)}_${conversationId}`.
 * OpenCode HOME directories hash unsafe/long ids separately.
 */
export function mcpAdvisorThreadId(input: {
  orgId: string
  actor: McpActor
  currentProjectName?: string | null
  conversationId: string
}): string {
  const actorKey =
    input.actor.type === "org-service" ? "org" : input.actor.userId
  return `${input.orgId}_${actorKey}_${slugify(input.currentProjectName ?? "default")}_${input.conversationId}`
}
