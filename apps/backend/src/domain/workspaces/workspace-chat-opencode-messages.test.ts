import { describe, expect, it } from "vitest"
import { messagesForOpenCodeChat } from "./workspace-chat-opencode-messages.js"

/** Mirrors `@tanstack/ai-opencode` `buildPrompt` / `extractText` (0.3.4). */
function openCodeTrailingUserText(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  const last = messages.at(-1)
  if (last?.role !== "user") return ""
  const content = last.content
  if (content === null || content === undefined) return ""
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "content" in part &&
      typeof part.content === "string"
        ? part.content
        : "",
    )
    .join("")
    .trim()
}

describe("messagesForOpenCodeChat", () => {
  it("leaves a trailing user string message unchanged", () => {
    const messages = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "hello" },
    ]
    expect(messagesForOpenCodeChat(messages, "hello")).toEqual(messages)
    expect(openCodeTrailingUserText(messages)).toBe("hello")
  })

  it("rewrites a trailing user whose text is only in parts", () => {
    const messages = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
      {
        role: "user",
        parts: [{ type: "text", text: "next turn" }],
      },
    ]
    const normalized = messagesForOpenCodeChat(messages, "next turn")
    expect(normalized.at(-1)).toMatchObject({
      role: "user",
      content: "next turn",
    })
    expect(openCodeTrailingUserText(normalized)).toBe("next turn")
  })

  it("appends the current prompt when the transcript ends on the assistant", () => {
    const messages = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
    ]
    const normalized = messagesForOpenCodeChat(messages, "next turn")
    expect(normalized).toHaveLength(3)
    expect(normalized.at(-1)).toEqual({
      role: "user",
      content: "next turn",
    })
    expect(openCodeTrailingUserText(normalized)).toBe("next turn")
  })

  it("uses the prompt when chat() would otherwise get an empty list", () => {
    const normalized = messagesForOpenCodeChat(undefined, "hello")
    expect(normalized).toEqual([{ role: "user", content: "hello" }])
    expect(openCodeTrailingUserText(normalized)).toBe("hello")
  })

  it("rewrites AG-UI user content parts that use text instead of content", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "from hydrate" }],
      },
    ]
    const normalized = messagesForOpenCodeChat(messages, "from hydrate")
    expect(openCodeTrailingUserText(messages)).toBe("")
    expect(openCodeTrailingUserText(normalized)).toBe("from hydrate")
  })
})
