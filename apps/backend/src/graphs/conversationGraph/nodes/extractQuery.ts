import type { BaseMessageLike } from "@langchain/core/messages"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../../auth/context.js"
import { generateEmbedding } from "../../../retrieval/services/embedding.js"
import type { ConversationGraphState } from "../state.js"

function extractQueryFromMessages(messages: BaseMessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (typeof m === "object" && m !== null && "content" in m) {
      const content = (m as { content?: unknown }).content
      if (typeof content === "string" && content.trim()) return content.trim()
      if (Array.isArray(content)) {
        const text = content
          .filter(
            (c): c is { type: string; text?: string } =>
              typeof c === "object" && c !== null,
          )
          .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
          .join("")
        if (text.trim()) return text.trim()
      }
    }
  }
  return ""
}

export async function extractQueryNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const query = extractQueryFromMessages(state.messages)
  if (!query) {
    return {}
  }

  const orgId = requireCurrentOrgId()
  const orgSlug = requireCurrentOrgSlug()

  const embedding = await generateEmbedding(query).catch(() => undefined)

  return {
    query,
    embedding: embedding ?? undefined,
    orgId,
    orgSlug,
  }
}
