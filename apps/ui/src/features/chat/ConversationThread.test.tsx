import { EventType, StreamProcessor } from "@tanstack/ai"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ChatMessage } from "@/features/chat/types"
import { ConversationThread } from "./ConversationThread"

function renderThread(
  messages: ChatMessage[],
  status?: "submitted" | "streaming" | "ready" | "error",
  waitLabel?: string,
) {
  return renderToStaticMarkup(
    <ConversationThread
      messages={messages}
      error={null}
      status={status}
      waitLabel={waitLabel}
    />,
  )
}

const user: ChatMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", content: "What's in this Workspace?" }],
}

describe("ConversationThread activity chrome", () => {
  it("keeps Thinking… as the live title until a reasoning heading arrives", () => {
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
    expect(html).toContain("data-reasoning-title")
    expect(html).toContain("Thinking…")
    expect(html).toContain("inspect the repository structure")
  })

  it("uses the latest reasoning heading as the live title", () => {
    const html = renderThread(
      [
        user,
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "thinking",
              content:
                "**Inspecting documentation steps**\n\nI should move forward carefully.\n**Consolidating documents**\n\nEditing docker.md next.",
            },
          ],
        },
      ],
      "streaming",
    )
    expect(html).toContain('data-reasoning-title="true"')
    expect(html).toMatch(
      /data-reasoning-title="true"[^>]*>Consolidating documents</,
    )
    expect(html).toContain("Inspecting documentation steps")
    expect(html).toContain("Editing docker.md next.")
    expect(html).not.toMatch(/data-reasoning-title="true"[^>]*>Thinking/)
  })

  it("uses icons on live tool chips and a pulsing dot only on reasoning", () => {
    const html = renderThread(
      [
        user,
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "thinking",
              content: "**Inspecting documentation steps**\n\nLooking next.",
            },
            { type: "tool-call", id: "tc_1", name: "hybrid_search" },
            { type: "tool-call", id: "tc_2", name: "get_file" },
          ],
        },
      ],
      "streaming",
    )
    expect(html).toContain("Read 1 file")
    expect(html).toContain("1 search")
    expect(html).toContain("tabler-icon-file")
    expect(html).toContain("tabler-icon-search")
    expect(html.match(/ctx-indexing-dot/g)).toHaveLength(1)
    expect(html).toContain("data-reasoning-title")
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
    expect(html).toContain("Read 1 file")
    expect(html).toContain("1 search")
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain("hybrid_search")
    expect(html).not.toContain("get_file")
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
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain("Reasoning")
    expect(html).toContain("inspect the repository")
    expect(html).toContain("This is a TypeScript monorepo.")
    expect(html).not.toContain("Thinking…")
  })

  it("renders markdown in collapsed reasoning instead of raw markers", () => {
    const html = renderThread(
      [
        user,
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "thinking",
              content:
                "**Inspecting repository options** I'm thinking we should look at the repo.",
            },
            { type: "text", content: "This is a TypeScript monorepo." },
          ],
        },
      ],
      "ready",
    )
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain("Inspecting repository options")
    expect(html).toContain('data-streamdown="strong"')
    expect(html).toContain("ctx-streamdown-reasoning-collapsed")
    expect(html).not.toContain("**Inspecting repository options**")
  })

  it("omits sender marks and timestamps", () => {
    const html = renderThread(
      [
        {
          ...user,
          createdAt: new Date("2026-08-16T09:42:00.000Z"),
        },
        {
          id: "a1",
          role: "assistant",
          createdAt: new Date("2026-08-16T09:42:16.000Z"),
          parts: [{ type: "text", content: "This is a TypeScript monorepo." }],
        },
      ],
      "ready",
    )
    expect(html).not.toContain("you")
    expect(html).not.toContain(">ctx<")
    expect(html).not.toContain("Aug")
    expect(html).not.toContain("2026")
  })

  it("shows Thinking… only before activity arrives", () => {
    const html = renderThread([user], "submitted")
    expect(html).toContain("Thinking…")
  })

  it("shows Setting up sandbox before Thinking… while the sandbox starts", () => {
    const html = renderThread([user], "submitted", "Setting up sandbox")
    expect(html).toContain("Setting up sandbox")
    expect(html).not.toContain("Thinking…")
  })

  it("hides setup and thinking wait copy once tools arrive", () => {
    const html = renderThread(
      [
        user,
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "tool-call", id: "tc_1", name: "read" }],
        },
      ],
      "streaming",
      "Setting up sandbox",
    )
    expect(html).toContain("Read 1 file")
    expect(html).not.toContain("Setting up sandbox")
    expect(html).not.toContain("Thinking…")
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
      type: EventType.RUN_STARTED,
      runId: "run_1",
      threadId: "conv_1",
      timestamp: Date.now(),
    })
    processor.processChunk({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "reason_1",
      role: "reasoning",
      timestamp: Date.now(),
    })
    processor.processChunk({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "reason_1",
      delta:
        "**Inspecting repositories**\n\nInspecting repositories for the sign-in path.",
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
    expect(html).toContain("1 search")
    expect(html).not.toContain("hybrid_search")
    expect(html).not.toMatch(/data-reasoning-title="true"[^>]*>Thinking/)
    expect(html).not.toContain("Auth0")

    processor.processChunk({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "text_1",
      role: "assistant",
      timestamp: Date.now(),
    })
    processor.processChunk({
      type: EventType.TEXT_MESSAGE_CONTENT,
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
    expect(withReply).toContain("1 search")
    expect(withReply).toContain('aria-expanded="false"')
  })

  // Fast / reasoning.effort=low often emits no REASONING_MESSAGE_* and no
  // planning-hold text. The UI only renders ReasoningBox when thinking parts
  // have text; empty reasoning is expected, not a dropped-event bug.
  it("collapses tool names to Read / search chips after the reply", () => {
    const html = renderThread(
      [
        user,
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-call",
              id: "tc_1",
              name: "hybrid_search",
              input: { query: "billing" },
            },
            {
              type: "tool-call",
              id: "tc_2",
              name: "get_file",
              input: { filePath: "knowledge/billing/ledger.md" },
            },
            { type: "text", content: "Billing lives in the ledger." },
          ],
        },
      ],
      "ready",
    )
    expect(html).toContain("Read 1 file")
    expect(html).toContain("1 search")
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain("hybrid_search")
    expect(html).not.toContain("get_file")
    expect(html).not.toContain("knowledge/billing/ledger.md")
    expect(html).toContain("Billing lives in the ledger.")
  })
})

function thinking(content: string) {
  return { type: "thinking", content }
}

function search(id: string) {
  return { type: "tool-call", id, name: "hybrid_search", input: { query: id } }
}

function assistant(parts: ChatMessage["parts"]): ChatMessage {
  return { id: "a1", role: "assistant", parts }
}

describe("ConversationThread earlier thinking blocks", () => {
  it("shows one thinking block without a Thought group", () => {
    const html = renderThread(
      [
        user,
        assistant([
          thinking("First idea about the ledger."),
          { type: "text", content: "Use the ledger." },
        ]),
      ],
      "ready",
    )
    expect(html).toContain('aria-label="Reasoning"')
    expect(html).toContain("First idea about the ledger.")
    expect(html).not.toContain("Thought")
  })

  it("labels one earlier block Thought and keeps the latest block visible", () => {
    const html = renderThread(
      [
        user,
        assistant([
          thinking("First idea about the ledger."),
          thinking("Second idea about invoices."),
          { type: "text", content: "Use the ledger." },
        ]),
      ],
      "ready",
    )
    expect(html).toContain('aria-label="Thought"')
    expect(html).toContain("Second idea about invoices.")
    expect(html).not.toContain("First idea about the ledger.")
  })

  it("collapses all earlier blocks into one Thought 2x group", () => {
    const html = renderThread(
      [
        user,
        assistant([
          thinking("First idea about the ledger."),
          thinking("Second idea about invoices."),
          thinking("Third idea about payments."),
          { type: "text", content: "Use the ledger." },
        ]),
      ],
      "ready",
    )
    expect(html.match(/aria-label="Thought 2x"/g)).toHaveLength(1)
    const groupTag = html.match(/<button[^>]*aria-label="Thought 2x"[^>]*>/)
    expect(groupTag?.[0]).toContain('aria-expanded="false"')
    expect(html).toContain("Third idea about payments.")
    expect(html).not.toContain("First idea about the ledger.")
    expect(html).not.toContain("Second idea about invoices.")
  })

  it("keeps the newest block live while the turn streams", () => {
    const html = renderThread(
      [
        user,
        assistant([
          thinking("First idea about the ledger."),
          thinking("Second idea about invoices."),
          thinking("**Checking payments**\n\nThird idea about payments."),
        ]),
      ],
      "streaming",
    )
    expect(html).toContain('aria-label="Thought 2x"')
    const live = html.slice(html.indexOf('role="status"'))
    expect(live).toContain('aria-label="Reasoning"')
    expect(live).toContain("Checking payments")
    expect(live).toContain("Third idea about payments.")
    expect(html).not.toContain("First idea about the ledger.")
    expect(html).not.toContain("Second idea about invoices.")
  })

  it("groups thinking across tool calls the same way tools group across thinking", () => {
    const html = renderThread(
      [
        user,
        assistant([
          thinking("First idea about the ledger."),
          search("tc_1"),
          thinking("Second idea about invoices."),
          search("tc_2"),
          thinking("Third idea about payments."),
          { type: "text", content: "Use the ledger." },
        ]),
      ],
      "ready",
    )
    expect(html.match(/aria-label="2 searches"/g)).toHaveLength(1)
    expect(html.match(/aria-label="Thought 2x"/g)).toHaveLength(1)
    const tools = html.indexOf('aria-label="2 searches"')
    const group = html.indexOf('aria-label="Thought 2x"')
    const latest = html.indexOf("Third idea about payments.")
    const reply = html.indexOf("Use the ledger.")
    expect(tools).toBeLessThan(group)
    expect(group).toBeLessThan(latest)
    expect(latest).toBeLessThan(reply)
  })
})
