import slugify from "@sindresorhus/slugify"
import type { McpActor } from "../auth/context.js"

/** Thread id shared by the MCP request span and the ctx_advisor tool span. */
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
