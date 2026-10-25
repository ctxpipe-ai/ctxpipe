import {
  chatParamsFromRequestBody,
  convertMessagesToModelMessages,
  type ModelMessage,
  type UIMessage,
  uiMessagesToWire,
} from "@tanstack/ai"
import { buildPrompt } from "@tanstack/ai-opencode"
import { describe, expect, it } from "vitest"

import {
  messagesForOpenCodeChat,
  openCodeTrailingUserMiddleware,
} from "./workspace-chat-opencode-messages.js"

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
    expect(normalized.at(-1)).toEqual({
      role: "user",
      content: "next turn",
    })
    expect(normalized.at(-1)).not.toHaveProperty("parts")
    expect(openCodeTrailingUserText(normalized)).toBe("next turn")
  })

  it("strips leftover parts so convert+OpenCode still see string content", () => {
    const rewritten = messagesForOpenCodeChat(
      [
        {
          role: "user",
          content: "next turn",
          parts: [{ type: "text", text: "next turn" }],
        },
      ],
      "next turn",
    )
    const converted = convertMessagesToModelMessages(
      rewritten as Array<ModelMessage | UIMessage>,
    )
    expect(openCodeTrailingUserText(converted)).toBe("next turn")
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

  it("re-applies the trailing user for the adapter only on middleware onConfig", async () => {
    const mw = openCodeTrailingUserMiddleware("next turn")
    const onConfig = mw.onConfig
    expect(onConfig).toEqual(expect.any(Function))
    if (!onConfig) return
    const result = await onConfig(
      { phase: "beforeModel" } as Parameters<typeof onConfig>[0],
      {
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "reply" },
        ],
        systemPrompts: [],
        tools: [],
      },
    )
    const patch = result && typeof result === "object" ? result : {}
    // The run's messages are the stored transcript. The copy is not a question.
    expect(patch).not.toHaveProperty("messages")
    const providerMessages =
      "providerMessages" in patch ? patch.providerMessages : undefined
    expect(providerMessages).toBeDefined()
    expect(openCodeTrailingUserText(providerMessages ?? [])).toBe("next turn")
  })

  it("gives OpenCode an earlier assistant turn that has no text", async () => {
    // The browser sends an assistant turn without text (a tool call only, or
    // a failed turn) as an AG-UI anchor without `content`.
    const history: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", content: "Run the tests" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "call-1",
            name: "bash",
            arguments: "{}",
            state: "input-complete",
          },
        ],
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", content: "And now?" }],
      },
    ]
    const params = await chatParamsFromRequestBody({
      threadId: "conv_example",
      runId: "run-1",
      messages: uiMessagesToWire(history),
      tools: [],
      context: [],
    })
    const onConfig = openCodeTrailingUserMiddleware("And now?").onConfig
    if (!onConfig) throw new Error("expected onConfig")
    const result = await onConfig(
      { phase: "init" } as Parameters<typeof onConfig>[0],
      {
        messages: convertMessagesToModelMessages(params.messages),
        systemPrompts: [],
        tools: [],
      },
    )
    const messages =
      result && typeof result === "object" && "messages" in result
        ? result.messages
        : undefined
    if (!messages) throw new Error("expected messages")
    expect(buildPrompt(messages, undefined).prompt).toBe(
      "Previous conversation:\nUser: Run the tests\n\nAnd now?",
    )
  })
})
