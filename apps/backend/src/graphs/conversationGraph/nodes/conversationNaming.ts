import type { BaseMessageLike } from "@langchain/core/messages"
import { getConfig, getWriter } from "@langchain/langgraph"
import {
  getConversation,
  updateConversation,
} from "../../../models/conversations.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"

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

  const unnamed =
    !conversation.name ||
    conversation.name === "New conversation" ||
    conversation.name === "New Chat"
  if (!unnamed) return {}

  const firstUserMessage = state.messages
    .filter((m) => (m as { getType?: () => string }).getType?.() === "human")
    .at(-1) as BaseMessageLike | undefined
  const promptText =
    typeof firstUserMessage?.content === "string"
      ? firstUserMessage.content
      : Array.isArray(firstUserMessage?.content)
        ? firstUserMessage.content
            .filter(
              (p): p is { type: string; text?: string } =>
                typeof p === "object" &&
                p !== null &&
                "text" in p &&
                typeof (p as { text?: unknown }).text === "string",
            )
            .map((p) => p.text)
            .join(" ")
        : ""
  const context = promptText.slice(0, 200).trim() || "New conversation"

  const model = getModel("fast", { temperature: 0.5 })
  const response = await model.invoke([
    { role: "user", content: titlePrompt + context },
  ])
  const raw =
    typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
        ? response.content
            .filter(
              (p): p is { type: string; text?: string } =>
                typeof p === "object" &&
                p !== null &&
                "text" in p &&
                typeof (p as { text?: unknown }).text === "string",
            )
            .map((p) => p.text)
            .join("")
        : ""
  const truncatedFallback =
    context === "New conversation" ? "New conversation" : context.slice(0, 80)
  const name = raw.trim().slice(0, 100) || truncatedFallback

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
