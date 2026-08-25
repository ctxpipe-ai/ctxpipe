/**
 * OpenCode `buildPrompt` only reads `message.content` as a string or as
 * `{ type: "text", content }` parts, and it requires the last message to be
 * that user text. After turn 1 the AG-UI transcript often ends on the assistant,
 * or the user text lives in `parts` / `text`. `convertMessagesToModelMessages`
 * prefers `parts` over `content`, so a rewrite that keeps `parts` still fails.
 * Persistence / sandbox `onConfig` can also replace the list after `chat()`.
 */
export function openCodeExtractableUserText(message: {
  role?: string
  content?: unknown
}): string {
  if (message.role !== "user") return ""
  const content = message.content
  if (content === null || content === undefined) return ""
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const record = part as { type?: unknown; content?: unknown }
      return record.type === "text" && typeof record.content === "string"
        ? record.content
        : ""
    })
    .join("")
    .trim()
}

export function messagesForOpenCodeChat<
  T extends { role?: string; content?: unknown; parts?: unknown[] },
>(messages: readonly T[] | undefined, prompt: string): T[] {
  const list = messages ? [...messages] : []
  const text = prompt.trim()
  if (!text) return list
  const last = list.at(-1)
  if (
    last &&
    !("parts" in last && last.parts != null) &&
    openCodeExtractableUserText(last) === text
  ) {
    return list
  }
  if (last?.role === "user") {
    const rest = { ...last }
    delete rest.parts
    return [...list.slice(0, -1), { ...rest, role: "user", content: text }]
  }
  return [...list, { role: "user", content: text } as T]
}

export function openCodeTrailingUserMiddleware(prompt: string) {
  return {
    name: "opencode-trailing-user",
    onConfig(
      _ctx: { phase?: string },
      config: { messages: Array<{ role?: string; content?: unknown }> },
    ) {
      return {
        messages: messagesForOpenCodeChat(config.messages, prompt),
      }
    },
  }
}
