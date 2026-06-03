/**
 * Hybrid MCP policy proxy.
 *
 * The table below is the source of truth for which AgentMemory tools the
 * agent sees and what ctxpipe does with each call. New AgentMemory tools
 * default to `hide` until we add an explicit policy entry so we never leak
 * upstream surface area without a deliberate decision.
 */
export type PolicyAction =
  | "write-markdown-then-hydrate"
  | "hydrate-then-query-or-markdown-fallback"
  | "gate-hosted-model"
  | "ctxpipe-native"
  | "hide"

export const POLICY: Record<string, PolicyAction> = {
  memory_save: "write-markdown-then-hydrate",
  memory_recall: "hydrate-then-query-or-markdown-fallback",
  memory_smart_search: "hydrate-then-query-or-markdown-fallback",
  memory_status: "ctxpipe-native",
  memory_summarize_session: "gate-hosted-model",
  memory_consolidate: "gate-hosted-model",
  memory_export: "hide",
  memory_governance_delete: "hide",
}

export type ToolSpec = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const DESCRIPTIONS: Record<string, ToolSpec> = {
  memory_save: {
    name: "memory_save",
    description:
      "Save a durable memory record into the canonical .ai/memory Markdown tree, then hydrate AgentMemory.",
    inputSchema: {
      type: "object",
      required: ["id", "body"],
      properties: {
        id: { type: "string", description: "Stable identifier (slug). Must be unique across the repo." },
        type: { type: "string", description: "Record category: architecture | decision | pattern | lesson | session | fact | note" },
        title: { type: "string", description: "Human-readable title; defaults to the id." },
        body: { type: "string", description: "Markdown body. Must be safe to commit." },
        concepts: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" } },
      },
    },
  },
  memory_recall: {
    name: "memory_recall",
    description:
      "Recall ctxpipe memories matching the query. Uses hydrated AgentMemory when available, falls back to direct Markdown search.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  memory_smart_search: {
    name: "memory_smart_search",
    description:
      "Smart search over ctxpipe memories. Like memory_recall but allows AgentMemory to use richer ranking when available.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  memory_status: {
    name: "memory_status",
    description:
      "Report current memory mode (signed-in / signed-out), runtime URL if any, and hosted model availability.",
    inputSchema: { type: "object", properties: {} },
  },
  memory_summarize_session: {
    name: "memory_summarize_session",
    description:
      "Summarize the current session into a durable lesson. Requires ctxpipe hosted model access.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        prompt: { type: "string" },
      },
    },
  },
  memory_consolidate: {
    name: "memory_consolidate",
    description:
      "Consolidate recent memories. Requires ctxpipe hosted model access.",
    inputSchema: { type: "object", properties: {} },
  },
}

export function toolSpec(name: string): ToolSpec {
  return (
    DESCRIPTIONS[name] ?? {
      name,
      description: `ctxpipe memory tool ${name}`,
      inputSchema: { type: "object", properties: {} },
    }
  )
}
