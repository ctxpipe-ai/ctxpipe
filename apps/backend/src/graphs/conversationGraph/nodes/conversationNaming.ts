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

export function isUnnamedConversation(
  name: string | null | undefined,
): boolean {
  return !name || name === "New conversation" || name === "New Chat"
}

export function textFromMessageContent(content: unknown, join = " "): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(
      (part): part is { type: string; text?: string } =>
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join(join)
}

/** One-shot title: model text, or truncated first user message. */
export function conversationTitleFromModel(
  raw: string,
  firstUserText: string,
): string {
  const context = firstUserText.slice(0, 200).trim() || "Conversation"
  const truncatedFallback = context.slice(0, 80)
  const name = raw.trim().slice(0, 100)
  if (name && !isUnnamedConversation(name)) return name
  return truncatedFallback
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
  if (!isUnnamedConversation(conversation.name)) return {}

  const firstUserMessage = state.messages.find(
    (m) => (m as { getType?: () => string }).getType?.() === "human",
  ) as BaseMessageLike | undefined
  const promptText = textFromMessageContent(firstUserMessage?.content)
  const context = promptText.slice(0, 200).trim() || "Conversation"

  let raw = ""
  try {
    const model = getModel("fast", { temperature: 0.5 })
    const response = await model.invoke([
      { role: "user", content: titlePrompt + context },
    ])
    raw = textFromMessageContent(response.content, "")
  } catch {
    raw = ""
  }
  const name = conversationTitleFromModel(raw, promptText)

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

export async function nameConversationIfUnnamed(input: {
  conversationId: string
  prompt: string
  generate?: (prompt: string) => Promise<string>
}): Promise<string | null> {
  const conversation = await getConversation(input.conversationId)
  if (!conversation || !isUnnamedConversation(conversation.name)) return null
  let raw = ""
  try {
    if (input.generate) {
      raw = await input.generate(titlePrompt + input.prompt.slice(0, 200))
    } else {
      const model = getModel("fast", { temperature: 0.5 })
      const response = await model.invoke([
        {
          role: "user",
          content: titlePrompt + input.prompt.slice(0, 200).trim(),
        },
      ])
      raw = textFromMessageContent(response.content, "")
    }
  } catch {
    raw = ""
  }
  const name = conversationTitleFromModel(raw, input.prompt)
  await updateConversation(input.conversationId, { name })
  return name
}
