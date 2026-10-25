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

function thinking(content: string) {
  return { type: "thinking", content }
}

function search(id: string) {
  return { type: "tool-call", id, name: "hybrid_search", input: { query: id } }
}

function assistant(parts: ChatMessage["parts"]): ChatMessage {
  return { id: "a1", role: "assistant", parts }
}

/** The text of every role="status" element in the markup. */
function statuses(html: string): string[] {
  return [...html.matchAll(/role="status"[^>]*aria-label="([^"]*)"/g)].map(
    (match) => match[1] ?? "",
  )
}

const inventedLabel =
  /Contextualizing|Analyzing|Traversing|Reading knowledge|Checking sources/

const ledgerThoughts = [
  thinking("**Reading the ledger**\n\nFirst idea about the ledger."),
  thinking("**Comparing invoices**\n\nSecond idea about invoices."),
  thinking("**Checking payments**\n\nThird idea about payments."),
]

describe("ConversationThread status line", () => {
  it("shows Thinking before any activity", () => {
    const html = renderThread([user], "submitted")
    expect(statuses(html)).toEqual(["Thinking"])
    expect(html).not.toMatch(inventedLabel)
  })

  it("shows the real sandbox state before any activity", () => {
    const html = renderThread([user], "submitted", "Setting up sandbox")
    expect(statuses(html)).toEqual(["Setting up sandbox"])
    expect(html).not.toContain("Thinking")
  })

  it("falls back to the system state, then Thinking, when tools run without a thought", () => {
    const tools = [user, assistant([search("tc_1")])]
    expect(statuses(renderThread(tools, "streaming"))).toEqual(["Thinking"])
    expect(
      statuses(renderThread(tools, "streaming", "Setting up sandbox")),
    ).toEqual(["Setting up sandbox"])
  })

  it("shows only the title of the latest thought while the agent works", () => {
    const html = renderThread(
      [user, assistant([...ledgerThoughts, search("tc_1")])],
      "streaming",
      "Setting up sandbox",
    )
    expect(statuses(html)).toEqual(["Checking payments"])
    expect(html).toContain("1 search")
    expect(html).toContain("3 thoughts")
    expect(html).not.toContain("Third idea about payments.")
    expect(html).not.toContain("Reading the ledger")
    expect(html).not.toContain("Comparing invoices")
    expect(html).not.toContain("Setting up sandbox")
    expect(html).not.toMatch(inventedLabel)
  })

  it("counts each heading of one reasoning text as a thought", () => {
    const html = renderThread(
      [
        user,
        assistant([
          thinking(
            "**Inspecting documentation steps**\n\nFirst.\n**Consolidating documents**\n\nEditing docker.md next.",
          ),
        ]),
      ],
      "streaming",
    )
    expect(html).toContain("2 thoughts")
    expect(statuses(html)).toEqual(["Consolidating documents"])
    expect(html).not.toContain("Inspecting documentation steps")
    expect(html).not.toContain("Editing docker.md next.")
  })

  it("keeps the status line while the status is still submitted", () => {
    const html = renderThread(
      [user, assistant([thinking("Inspect the repository structure.")])],
      "submitted",
    )
    expect(statuses(html)).toEqual(["Inspect the repository structure."])
    expect(html).toContain("1 thought")
  })

  it("hides the current thought when the answer is done and keeps the counters", () => {
    const html = renderThread(
      [
        user,
        assistant([
          ...ledgerThoughts,
          search("tc_1"),
          { type: "text", content: "Use the ledger." },
        ]),
      ],
      "ready",
    )
    expect(statuses(html)).toEqual([])
    expect(html).toContain('aria-label="1 search, 3 thoughts"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain("Checking payments")
    expect(html).toContain("Use the ledger.")
  })

  it("keeps the current thought while text streams and the run goes on", () => {
    const html = renderThread(
      [
        user,
        assistant([
          ...ledgerThoughts,
          { type: "text", content: "Let me check" },
          search("tc_2"),
        ]),
      ],
      "streaming",
    )
    expect(statuses(html)).toEqual(["Checking payments"])
  })

  it("hides the status line when the run ends with an error", () => {
    const html = renderThread([user, assistant(ledgerThoughts)], "error")
    expect(statuses(html)).toEqual([])
  })

  it("omits sender marks and timestamps", () => {
    const html = renderThread(
      [
        { ...user, createdAt: new Date("2026-08-16T09:42:00.000Z") },
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
})

describe("ConversationThread with AG-UI chunks", () => {
  it("counts each reasoning step and shows the latest one until the run ends", () => {
    const processor = new StreamProcessor({
      initialMessages: [
        {
          id: user.id,
          role: "user",
          parts: [{ type: "text", content: "What's in this Workspace?" }],
        },
      ],
    })
    const now = Date.now()
    processor.processChunk({
      type: EventType.RUN_STARTED,
      runId: "run_1",
      threadId: "conv_1",
      timestamp: now,
    })
    processor.processChunk({
      type: EventType.STEP_STARTED,
      stepName: "step_1",
      timestamp: now,
    })
    processor.processChunk({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "reason_1",
      delta: "First idea about the ledger.",
      timestamp: now,
    })
    processor.processChunk({
      type: EventType.STEP_STARTED,
      stepName: "step_2",
      timestamp: now,
    })
    processor.processChunk({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "reason_2",
      delta: "**Comparing invoices**\n\nSecond idea about invoices.",
      timestamp: now,
    })
    processor.processChunk({
      type: "TOOL_CALL_START",
      toolCallId: "call_1",
      toolCallName: "hybrid_search",
      timestamp: now,
    })

    const html = renderThread(
      processor.getMessages() as ChatMessage[],
      "streaming",
    )
    expect(html).toContain('aria-label="1 search, 2 thoughts"')
    expect(statuses(html)).toEqual(["Comparing invoices"])
    expect(html).not.toContain("Second idea about invoices.")
    expect(html).not.toContain("First idea about the ledger.")

    processor.processChunk({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "text_1",
      role: "assistant",
      timestamp: now,
    })
    processor.processChunk({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "text_1",
      delta: "Sign-in is handled by Auth0.",
      timestamp: now,
    })
    const withReply = renderThread(
      processor.getMessages() as ChatMessage[],
      "streaming",
    )
    expect(withReply).toContain("Sign-in is handled by Auth0.")
    expect(withReply).toContain('aria-label="1 search, 2 thoughts"')
    expect(statuses(withReply)).toEqual(["Comparing invoices"])
    const done = renderThread(processor.getMessages() as ChatMessage[], "ready")
    expect(statuses(done)).toEqual([])
  })
})
