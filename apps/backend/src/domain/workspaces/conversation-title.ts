import { chat } from "@tanstack/ai"

import {
  getConversation,
  nameUnnamedConversation,
} from "../../models/conversations.js"
import { getModel } from "../../retrieval/services/modelProvider.js"
import { maskCredentials } from "./mask-credentials.js"

const titlePrompt =
  `Generate a short 2-5 word title for a chat conversation. Reply with ONLY the title, no quotes or punctuation.
First user message: ` as const

/** True for no name or a default label. `nameUnnamedConversation` checks the same labels in SQL. */
export function isUnnamedConversation(
  name: string | null | undefined,
): boolean {
  return !name || name === "New conversation" || name === "New Chat"
}

/** The longest title, so it fits a pull request title and a commit subject. */
const maxTitleLength = 72

/**
 * One line of plain text for a title: the first line that is not empty,
 * with credentials masked, without a heading mark, a "Title:" label, quotes or
 * a trailing period, and cut at a word to at most 72 characters. Empty when
 * nothing is left.
 */
export function cleanTitle(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean) ?? ""
  const title = maskCredentials(line)
    .replace(/^#+\s*/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`*_“”‘’]+|[\s"'`*_“”‘’.,;:]+$/g, "")
  if (title.length <= maxTitleLength) return title
  const cut = title.slice(0, maxTitleLength + 1)
  const space = cut.lastIndexOf(" ")
  return (
    space > 0 ? cut.slice(0, space) : cut.slice(0, maxTitleLength)
  ).replace(/[\s.,;:]+$/, "")
}

/**
 * One-shot title: the model's title, or the first user message. A reply of
 * more than 8 words is a sentence, not a title, so the fallback is used.
 */
export function conversationTitleFromModel(
  raw: string,
  firstUserText: string,
): string {
  const name = cleanTitle(raw)
  if (name && !isUnnamedConversation(name) && name.split(" ").length <= 8)
    return name
  return cleanTitle(firstUserText.slice(0, 200)) || "Conversation"
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
      const model = getModel("fast", {
        temperature: 0.5,
        name: "workspace.conversation-title",
      })
      raw = await chat({
        adapter: model,
        messages: [
          {
            role: "user",
            content: titlePrompt + input.prompt.slice(0, 200).trim(),
          },
        ],
        stream: false,
      })
    }
  } catch {
    raw = ""
  }
  const name = conversationTitleFromModel(raw, input.prompt)
  // The user can rename while the model works. The write then changes no row.
  const named = await nameUnnamedConversation(input.conversationId, name)
  return named ? name : null
}
