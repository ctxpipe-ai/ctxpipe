import type { BaseMessageLike } from "@langchain/core/messages"
import { AIMessage, SystemMessage } from "@langchain/core/messages"
import { createAgent } from "langchain"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import { getFileTool } from "../../../tools/getFile.js"
import { listFilesTool } from "../../../tools/listFiles.js"
import { listRepositoriesTool } from "../../../tools/listRepositories.js"
import { searchTool } from "../../../tools/search.js"
import type { ConversationGraphState } from "../state.js"

const retrievalAugmentedInstructions = `
You are a code-context assistant with retrieval-augmented knowledge.

You have access to:
1) Pre-retrieved context from the last user message (code search, claims, graph).
2) Tools for follow-up: search, list_files, get_file.

Use the retrieval context first. If you need more detail or the context is insufficient, use the tools.
Ground answers in retrieval context or tool output. State clearly when information is missing.
`.trim()

const agent = createAgent({
  model: getModel("medium"),
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
    { streamMode: "values" },
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
