import type { BaseMessageLike } from "@langchain/core/messages"
import { getConfig, getWriter } from "@langchain/langgraph"
import { createAILogger, createEvlogIntegration } from "evlog/ai"
import { generateText } from "ai"
import {
  getConversation,
  updateConversation,
} from "../../../models/conversations.js"
import { getLogger } from "../../../observability/logger.js"
import {
  getModelIdForTier,
  getOpenRouterChatLanguageModel,
} from "../../../retrieval/services/modelProvider.js"

const titlePrompt =
  `Generate a short 2-5 word title for a chat conversation. Reply with ONLY the title, no quotes or punctuation.
First user message: ` as const

export type ConversationNamingState = {
  messages: BaseMessageLike[]
  conversationName?: string
}

export async function conversationNaming(
  state: ConversationNamingState,
): Promise<Partial<ConversationNamingState>> {
  const config = getConfig()
  const conversationId = config.configurable?.thread_id as string | undefined
  const source = config.configurable?.source as string | undefined

  if (!conversationId) return {}

  const conversation = await getConversation(conversationId)
  if (!conversation) return {}

  const hasName = conversation.name && conversation.name !== "New Chat"
  if (hasName) return {}

  const firstUserMessage = state.messages
    .filter((m) => (m as { getType?: () => string }).getType?.() === "human")
    .at(-1) as BaseMessageLike | undefined
  const msgContent = (firstUserMessage as { content?: unknown } | undefined)
    ?.content
  const promptText =
    typeof msgContent === "string"
      ? msgContent
      : Array.isArray(msgContent)
        ? msgContent
            .filter(
              (p: unknown): p is { type: string; text?: string } =>
                typeof p === "object" &&
                p !== null &&
                "text" in p &&
                typeof (p as { text?: unknown }).text === "string",
            )
            .map((p) => p.text)
            .join(" ")
        : ""
  const context = promptText.slice(0, 200).trim() || "New conversation"

  const log = getLogger()
  const ai = createAILogger(log)
  const { text: raw } = await generateText({
    model: ai.wrap(getOpenRouterChatLanguageModel(getModelIdForTier("fast"))),
    prompt: titlePrompt + context,
    temperature: 0.5,
    experimental_telemetry: {
      isEnabled: true,
      integrations: [createEvlogIntegration(ai)],
    },
  })
  const name = raw.trim().slice(0, 100) || "New Chat"

  await updateConversation(conversationId, { name })

  if (source === "ui") {
    const writer = getWriter()
    writer?.({
      type: "rename-conversation",
      name,
    })
    return { conversationName: name }
  }
  return {}
}
