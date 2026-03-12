import type { BaseMessageLike } from "@langchain/core/messages"
import { AIMessage, SystemMessage } from "@langchain/core/messages"
import { createAgent } from "langchain"
import { getLangfuseHandler } from "../../../observability/langfuse.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import { getFileTool } from "../../../tools/getFile.js"
import { listFilesTool } from "../../../tools/listFiles.js"
import { listRepositoriesTool } from "../../../tools/listRepositories.js"
import { searchTool } from "../../../tools/search.js"
import type { ConversationGraphState } from "../state.js"

const retrievalAugmentedInstructions = `
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

You have access to: (1) Pre-retrieved context (code search, claims, graph, fleet-wide patterns). (2) Tools for follow-up: search, list_files, get_file.
Use retrieval context first. Use tools only when context is insufficient. Respond in natural language.
`.trim()

const agent = createAgent({
  model: getModel("medium", { temperature: 0.2 }),
  tools: [listRepositoriesTool, searchTool, listFilesTool, getFileTool],
  systemPrompt: retrievalAugmentedInstructions,
})

export async function agentNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { messages, retrievalContext } = state

  const inputMessages: BaseMessageLike[] = [
    new SystemMessage(retrievalContext ?? "No retrieval context."),
    ...messages,
  ]

  const stream = await agent.stream(
    { messages: inputMessages },
    { streamMode: "values", callbacks: [getLangfuseHandler()] },
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
