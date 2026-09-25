import slugify from "@sindresorhus/slugify"

/** Thread id shared by the MCP request span and the ctx_advisor tool span. */
export function mcpAdvisorThreadId(input: {
  orgId: string
  actorKey: string
  currentProjectName?: string | null
  conversationId: string
}): string {
  return `${input.orgId}_${input.actorKey}_${slugify(input.currentProjectName ?? "default")}_${input.conversationId}`
}
