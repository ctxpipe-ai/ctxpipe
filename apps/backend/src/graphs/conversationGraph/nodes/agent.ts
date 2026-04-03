import type { BaseMessageLike } from "@langchain/core/messages"
import { AIMessage, SystemMessage } from "@langchain/core/messages"
import { getConfig } from "@langchain/langgraph"
import { langfusePipelineCallbacks } from "../../../observability/langfusePipelineMetrics.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import { listRepositoriesTool } from "../../../tools/listRepositories.js"
import { standardRepoExplorerTools } from "../../../tools/repoExplorerTools.js"
import { createAgent } from "../../createAgent.js"
import type { ConversationGraphState } from "../state.js"

const baseInstructions = `
You are the organizational context advisor. You answer questions using the knowledge graph, claims, and patterns — not just raw retrieval.

GOAL: Surface what is RECOMMENDED and COMMON in this org — not merely what tools support.
- "What database?" → What do similar services use? What's in ADRs? What's common across the fleet?
- "What framework?" → Same reasoning: patterns, conventions, validated approaches.

REASONING:
1. Use claims (subject-predicate-object) to infer relationships (e.g. Service X WRITES_TO Postgres).
2. Aggregate: if many services use Postgres, that's the recommendation.
3. Prefer ADRs, instructions, and high-confidence claims over isolated code matches.

PUSHBACK: When the user suggests something that contradicts org patterns:
- Acknowledge their preference.
- Explain what the graph shows (e.g. "All services use Postgres").
- Recommend the org standard with evidence.
- Offer to help with the recommended approach.

You have access to: (1) Pre-retrieved context (code search, claims, graph, fleet-wide patterns). (2) Tools for follow-up: list_repositories, list_files, search, find_symbol_definitions, find_symbol_references, graph_find_symbol, graph_get_callers, graph_get_callees, get_file.
Use retrieval context first. Use tools only when context is insufficient.
For lexical discovery use search (Zoekt) first. For structural questions (callers/callees, definitions via AST graph) use graph_* tools with symbol/file/module anchors — they are not org memory. When you know a symbol name and language for a repo, Zoekt sym: tools remain useful when the code graph is not ready.

Tool use (efficiency): Zoekt is fast; use it to discover paths and symbols when you lack anchors. get_file when you already have a path. Code graph tools are slower — use them sparingly for structure (definitions, callers, callees). For "who calls X" / callers / callees when the symbol and repository are already clear from the question or retrieval context, call graph_get_callers or graph_get_callees directly instead of running broad Zoekt search first; fall back to search/sym only if you need anchors or the graph returns nothing useful.
`.trim()

const humanResponseFormat = `
Respond in natural language.
`.trim()

const agentResponseFormat = `
RESPONSE FORMAT (primary consumers are agents):
- Be concise. Use bullet points, structured facts, minimal prose.
- Lead with the answer or recommendation. Avoid preamble.
- Omit conversational filler ("Certainly!", "Let me explain", "In summary").
- Prefer clear facts over long paragraphs. For example: "Postgres. 12 services use it; ADR-003 recommends."
`.trim()

const agentHuman = createAgent({
  model: getModel("medium", { temperature: 0.2 }),
  tools: [listRepositoriesTool, ...standardRepoExplorerTools],
  systemPrompt: `${baseInstructions}\n\n${humanResponseFormat}`,
})

const agentMcp = createAgent({
  model: getModel("medium", { temperature: 0.2 }),
  tools: [listRepositoriesTool, ...standardRepoExplorerTools],
  systemPrompt: `${baseInstructions}\n\n${agentResponseFormat}`,
})

export async function agentNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { messages, retrievalContext } = state
  const config = getConfig()
  const source = config.configurable?.source as string | undefined
  const agent = source === "mcp" ? agentMcp : agentHuman

  const inputMessages: BaseMessageLike[] = [
    new SystemMessage(retrievalContext ?? "No retrieval context."),
    ...messages,
  ]

  const stream = await agent.stream(
    { messages: inputMessages },
    {
      streamMode: "values",
      callbacks: langfusePipelineCallbacks({
        step: "conversation.agent",
        dimensions: { source: source ?? "ui" },
      }),
    },
  )

  let finalMessages: BaseMessageLike[] | undefined
  for await (const chunk of stream) {
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "messages" in chunk &&
      Array.isArray(chunk.messages)
    ) {
      finalMessages = chunk.messages as BaseMessageLike[]
    }
  }

  if (!finalMessages) {
    return {
      messages: [new AIMessage("No answer could be produced.")],
    }
  }

  const generatedMessages = finalMessages.slice(inputMessages.length)
  if (generatedMessages.length === 0) {
    return {
      messages: [new AIMessage("No answer could be produced.")],
    }
  }

  return {
    messages: generatedMessages as ConversationGraphState["messages"],
  }
}
