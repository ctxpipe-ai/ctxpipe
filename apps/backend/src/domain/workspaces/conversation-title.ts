import {
  getConversation,
  updateConversation,
} from "../../models/conversations.js"
import { getModel } from "../../retrieval/services/modelProvider.js"

const titlePrompt =
  `Generate a short 2-5 word title for a chat conversation. Reply with ONLY the title, no quotes or punctuation.
First user message: ` as const

export function isUnnamedConversation(
  name: string | null | undefined,
): boolean {
  return !name || name === "New conversation" || name === "New Chat"
}

function textFromMessageContent(content: unknown): string {
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
    .join("")
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
      raw = textFromMessageContent(response.content)
    }
  } catch {
    raw = ""
  }
  const name = conversationTitleFromModel(raw, input.prompt)
  await updateConversation(input.conversationId, { name })
  return name
}
