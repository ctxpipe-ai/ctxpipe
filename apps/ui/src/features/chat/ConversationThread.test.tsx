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
})
