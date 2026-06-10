import { requireCurrentOrgId, requireCurrentUserId } from "../auth/context.js"
import { getSystemDb } from "../db/client.js"
import { agentActivityEvents } from "../db/schema/agent_activity_events.js"
import { generateObjectId } from "../lib/id.js"

export type AgentActivitySource = "ui" | "mcp" | "knowledge-graph" | "other"

export type AgentActivityEventType =
  | "conversation.message"
  | "mcp.tool.called"
  | "knowledge-graph.ask"

export function normaliseAgentActivitySource(
  source: string | null | undefined,
): AgentActivitySource {
  if (source === "ui" || source === "mcp" || source === "knowledge-graph") {
    return source
  }
  return "other"
}

export async function recordAgentActivityEvent(input: {
  orgId?: string
  userId?: string
  source: string | null | undefined
  eventType: AgentActivityEventType
  subjectId?: string | null
  metadata?: Record<string, unknown>
}): Promise<void> {
  const orgId = input.orgId ?? requireCurrentOrgId()
  const userId = input.userId ?? requireCurrentUserId()
  const db = getSystemDb()
  await db.insert(agentActivityEvents).values({
    id: generateObjectId("aae"),
    orgId,
    userId,
    source: normaliseAgentActivitySource(input.source),
    eventType: input.eventType,
    subjectId: input.subjectId ?? null,
    metadata: input.metadata ?? {},
  })
}
