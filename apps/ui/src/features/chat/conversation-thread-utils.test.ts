import { describe, expect, it } from "vitest"
import {
  activityChips,
  activityLog,
  groupAssistantTurns,
  splitThoughts,
  toolBucket,
  toolBucketCounts,
  toolCallAction,
  toolCallDetail,
} from "./conversation-thread-utils"

describe("conversation thread tool summary", () => {
  it("buckets OpenCode and explorer names", () => {
    expect(toolBucket("read")).toBe("read")
    expect(toolBucket("get_file")).toBe("read")
    expect(toolBucket("glob")).toBe("search")
    expect(toolBucket("glob_files")).toBe("search")
    expect(toolBucket("hybrid_search")).toBe("search")
    expect(toolBucket("bash")).toBe("tool")
    expect(toolBucket("graph_get_callers")).toBe("tool")
  })

  it("finds the main argument in the input or the raw arguments", () => {
    expect(
      toolCallDetail({
        input: { filePath: "apps/ui/src/features/chat/ConversationThread.tsx" },
      }),
    ).toBe("apps/ui/src/features/chat/ConversationThread.tsx")
    expect(
      toolCallDetail({ arguments: JSON.stringify({ pattern: "**/*.md" }) }),
    ).toBe("**/*.md")
    expect(
      toolCallDetail({ input: { query: "where is login documented" } }),
    ).toBe("where is login documented")
    expect(toolCallDetail({})).toBeNull()
    expect(toolCallDetail({ arguments: "{not json" })).toBeNull()
  })

  it("names the action of known tools and keeps the name of other tools", () => {
    expect(toolCallAction("read")).toBe("Read file")
    expect(toolCallAction("glob")).toBe("Search")
    expect(toolCallAction("bash")).toBe("Run command")
    expect(toolCallAction("edit")).toBe("Edit file")
    expect(toolCallAction("graph_get_callers")).toBe("graph_get_callers")
  })

  it("counts unique calls and thoughts on the counters line", () => {
    const entries = activityLog([
      {
        type: "thinking",
        content: "**Reading**\n\nFirst.\n**Comparing**\n\nSecond.",
      },
      {
        type: "tool-call",
        id: "tc_1",
        name: "read",
        input: { path: "knowledge/billing/ledger.md" },
      },
      { type: "tool-call", id: "tc_1", name: "read" },
      {
        type: "tool-call",
        id: "tc_2",
        name: "glob",
        input: { pattern: "knowledge/**/*.md" },
      },
      {
        type: "tool-call",
        id: "tc_3",
        name: "hybrid_search",
        input: { query: "billing" },
      },
      {
        type: "tool-call",
        id: "tc_4",
        name: "bash",
        input: { command: "ls" },
      },
    ])
    const tools = entries.flatMap((entry) =>
      entry.kind === "tool" ? [entry.tool] : [],
    )
    expect(toolBucketCounts(tools)).toEqual({ reads: 1, searches: 2, tools: 1 })
    expect(
      activityChips({ ...toolBucketCounts(tools), thoughts: 2 }).map(
        (chip) => chip.label,
      ),
    ).toEqual(["Read 1 file", "2 searches", "Used 1 tool", "2 thoughts"])
    expect(
      entries.map((entry) =>
        entry.kind === "tool" ? entry.tool.detail : entry.thought.title,
      ),
    ).toEqual([
      "Reading",
      "Comparing",
      "knowledge/billing/ledger.md",
      "knowledge/**/*.md",
      "billing",
      "ls",
    ])
  })
})

describe("splitThoughts", () => {
  it("starts a thought at each bold or ATX heading", () => {
    expect(
      splitThoughts(
        "**Inspecting documentation steps**\n\nI should move forward carefully.**Implementing document updates**\nNext I will edit docker.md.\n## Checking",
      ),
    ).toEqual([
      {
        title: "Inspecting documentation steps",
        hasHeading: true,
        body: "I should move forward carefully.",
      },
      {
        title: "Implementing document updates",
        hasHeading: true,
        body: "Next I will edit docker.md.",
      },
      { title: "Checking", hasHeading: true, body: "" },
    ])
  })

  it("titles a thought without a heading with its short first line", () => {
    const long = `${"word ".repeat(30)}end`
    const [thought] = splitThoughts(`${long}\nMore text.`)
    expect(thought?.hasHeading).toBe(false)
    expect(thought?.title.length).toBeLessThanOrEqual(80)
    expect(thought?.title.endsWith("…")).toBe(true)
    expect(thought?.body).toBe(`${long}\nMore text.`)
    expect(splitThoughts("  \n ")).toEqual([])
  })
})

describe("groupAssistantTurns", () => {
  it("merges consecutive assistant messages of one turn, in order", () => {
    const turns = groupAssistantTurns([
      { id: "u1", role: "user", parts: [{ type: "text", content: "Why?" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "thinking", content: "**Inspecting**" },
          { type: "tool-call", id: "c1", name: "read", input: {} },
        ],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "thinking", content: "**Answering**" },
          { type: "text", content: "Because." },
        ],
      },
      { id: "u2", role: "user", parts: [{ type: "text", content: "Thanks" }] },
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", content: "Sure." }],
      },
    ])
    expect(turns.map((turn) => turn.id)).toEqual(["u1", "a1", "u2", "a2"])
    expect(turns[1]?.parts.map((part) => part.type)).toEqual([
      "thinking",
      "tool-call",
      "thinking",
      "text",
    ])
  })

  it("leaves a live single assistant message as it is", () => {
    const messages = [
      {
        id: "u1",
        role: "user" as const,
        parts: [{ type: "text", content: "Hi" }],
      },
      {
        id: "a1",
        role: "assistant" as const,
        parts: [{ type: "text", content: "Hello" }],
      },
    ]
    expect(groupAssistantTurns(messages)).toEqual(messages)
  })
})
