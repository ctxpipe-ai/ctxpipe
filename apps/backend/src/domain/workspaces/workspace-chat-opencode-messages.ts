/**
 * OpenCode's `buildPrompt` only reads `message.content` as a string or as
 * `{ type: "text", content }` parts, and it requires the last message to be
 * that user text. After turn 1 the AG-UI client often resends a transcript
 * that ends on the assistant (or a user whose text lives in `parts` / `text`).
 * Rewrite just enough so `chat()` still gets the full history.
 */
export function messagesForOpenCodeChat<
  T extends { role?: string; content?: unknown; parts?: unknown[] },
>(messages: readonly T[] | undefined, prompt: string): T[] {
  const list = messages ? [...messages] : []
  const text = prompt.trim()
  if (!text) return list
  const last = list.at(-1)
  if (last?.role === "user") {
    if (
      typeof last.content === "string" &&
      last.content.trim() === text
    ) {
      return list
    }
    return [
      ...list.slice(0, -1),
      { ...last, role: "user", content: text },
    ]
  }
  return [...list, { role: "user", content: text } as T]
}
