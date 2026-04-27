import { getConfig, getWriter } from "@langchain/langgraph"
import type { ConversationGraphState } from "../state.js"

const MAX_FOCUS_NODE_IDS = 32

type KnowledgeGraphFocusEvent = {
  type: "kg-focus"
  nodeIds: string[]
  reason: string
  fitView: boolean
}

function pushString(out: Set<string>, value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) {
    out.add(value)
  }
}

function pushStrings(out: Set<string>, value: unknown) {
  if (!Array.isArray(value)) return
  for (const item of value) pushString(out, item)
}

export function collectKnowledgeGraphFocusNodeIds(
  state: ConversationGraphState,
): string[] {
  const out = new Set<string>()

  for (const candidate of state.candidates ?? []) {
    pushString(out, candidate.objectId)
    pushStrings(out, candidate.payload?.nodeIds)
    pushString(out, candidate.payload?.sourceId)
    pushString(out, candidate.payload?.targetId)
    if (out.size >= MAX_FOCUS_NODE_IDS) break
  }

  for (const node of state.graphNodes ?? []) {
    pushString(out, (node as { id?: unknown }).id)
    if (out.size >= MAX_FOCUS_NODE_IDS) break
  }

  for (const traversal of state.traversalResults ?? []) {
    pushStrings(out, (traversal as { nodeIds?: unknown }).nodeIds)
    if (out.size >= MAX_FOCUS_NODE_IDS) break
  }

  return [...out].slice(0, MAX_FOCUS_NODE_IDS)
}

export async function knowledgeGraphFocusNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const source = getConfig().configurable?.source as string | undefined
  if (source !== "knowledge-graph") return {}

  const nodeIds = collectKnowledgeGraphFocusNodeIds(state)
  if (nodeIds.length === 0) return {}

  const writer = getWriter()
  writer?.({
    type: "kg-focus",
    nodeIds,
    reason: state.query ?? "Graph answer focus",
    fitView: true,
  } satisfies KnowledgeGraphFocusEvent)

  return {}
}
