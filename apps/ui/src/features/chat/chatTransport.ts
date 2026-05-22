import { DefaultChatTransport } from "ai"

export function createTransport(input: {
  orgSlug: string
  conversationId: string
  source?: string
  getMessageContext?: () => string | null
}) {
  return new DefaultChatTransport({
    api: `/${input.orgSlug}/api/v1/conversations/${input.conversationId}`,
    credentials: "include",
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        message: withMessageContext(
          messages[messages.length - 1],
          input.getMessageContext?.() ?? null,
        ),
        source: input.source ?? "ui",
      },
    }),
  })
}

function withMessageContext<T>(message: T, context: string | null): T {
  if (!context?.trim()) return message
  if (!message || typeof message !== "object") return message

  const suffix = `\n\nKnowledge graph context:\n${context.trim()}`
  const out = { ...(message as Record<string, unknown>) }
  const parts = out.parts
  if (Array.isArray(parts)) {
    out.parts = parts.map((part, index) => {
      if (
        index === parts.length - 1 &&
        part &&
        typeof part === "object" &&
        "type" in part &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return {
          ...(part as Record<string, unknown>),
          text: `${(part as { text: string }).text}${suffix}`,
        }
      }
      return part
    })
    return out as T
  }

  if (typeof out.content === "string") {
    out.content = `${out.content}${suffix}`
  }
  return out as T
}
