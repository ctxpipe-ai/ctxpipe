import { StreamProcessor } from "@tanstack/ai"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ChatMessage } from "@/features/chat/types"
import { ConversationThread } from "./ConversationThread"

function renderThread(
  messages: ChatMessage[],
  status?: "submitted" | "streaming" | "ready" | "error",
) {
  return renderToStaticMarkup(
    <ConversationThread messages={messages} error={null} status={status} />,
  )
}

const user: ChatMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", content: "What's in this Workspace?" }],
}

describe("ConversationThread activity chrome", () => {
  it("hides Thinking… once a reasoning part exists", () => {
    const html = renderThread(
      [
        user,
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "thinking",
              content: "I'll inspect the repository structure.",
            },
          ],
        },
      ],
      "streaming",
    )
    expect(html).toContain("Reasoning")
    expect(html).toContain("inspect the repository structure")
    expect(html).not.toContain("Thinking…")
  })

  it("shows a live tool counter and hides Thinking…", () => {
    const html = renderThread(
      [
        user,
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "tool-call", id: "tc_1", name: "hybrid_search" },
            { type: "tool-call", id: "tc_2", name: "get_file" },
          ],
        },
      ],
      "streaming",
    )
    expect(html).toContain("Used")
    expect(html).toContain("2")
    expect(html).toContain("hybrid_search")
    expect(html).toContain("get_file")
    expect(html).not.toContain("Thinking…")
  })

  it("collapses reasoning after reply text starts", () => {
    const html = renderThread(
      [
        user,
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "thinking", content: "I'll inspect the repository." },
            { type: "text", content: "This is a TypeScript monorepo." },
          ],
        },
      ],
      "ready",
    )
    expect(html).toContain("<details")
    expect(html).toContain("Reasoning")
    expect(html).toContain("This is a TypeScript monorepo.")
    expect(html).not.toContain("Thinking…")
  })

  it("shows Thinking… only before activity arrives", () => {
    const html = renderThread([user], "submitted")
    expect(html).toContain("Thinking…")
  })

  it("hides Thinking… when activity exists while status is still submitted", () => {
    const html = renderThread(
      [
        user,
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "thinking",
              content: "I'll inspect the repository structure.",
            },
          ],
        },
      ],
      "submitted",
    )
    expect(html).toContain("Reasoning")
    expect(html).not.toContain("Thinking…")
  })

  it("renders reasoning and tools from AG-UI chunks before reply text", () => {
    const processor = new StreamProcessor({
      initialMessages: [
        {
          id: user.id,
          role: "user",
          parts: [{ type: "text", content: "What's in this Workspace?" }],
        },
      ],
    })
    processor.processChunk({
      type: "RUN_STARTED",
      runId: "run_1",
      threadId: "conv_1",
      timestamp: Date.now(),
    })
    processor.processChunk({
      type: "REASONING_MESSAGE_START",
      messageId: "reason_1",
      role: "reasoning",
      timestamp: Date.now(),
    })
    processor.processChunk({
      type: "REASONING_MESSAGE_CONTENT",
      messageId: "reason_1",
      delta: "Inspecting repositories for the sign-in path.",
      timestamp: Date.now(),
    })
    processor.processChunk({
      type: "TOOL_CALL_START",
      toolCallId: "call_1",
      toolCallName: "hybrid_search",
      timestamp: Date.now(),
    })

    const html = renderThread(
      processor.getMessages() as ChatMessage[],
      "streaming",
    )
    expect(html).toContain("Reasoning")
    expect(html).toContain("Inspecting repositories")
    expect(html).toContain("hybrid_search")
    expect(html).toContain("Used")
    expect(html).not.toContain("Thinking…")
    expect(html).not.toContain("Auth0")

    processor.processChunk({
      type: "TEXT_MESSAGE_START",
      messageId: "text_1",
      role: "assistant",
      timestamp: Date.now(),
    })
    processor.processChunk({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "text_1",
      delta: "Sign-in is handled by Auth0.",
      timestamp: Date.now(),
    })
    const withReply = renderThread(
      processor.getMessages() as ChatMessage[],
      "streaming",
    )
    expect(withReply).toContain("Sign-in is handled by Auth0.")
    expect(withReply).toContain("Reasoning")
    expect(withReply).toContain("hybrid_search")
  })
})
