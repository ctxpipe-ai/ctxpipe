import { describe, expect, it } from "vitest"
import {
  collapsedToolSummary,
  latestReasoningHeading,
  normalizeReasoningMarkdown,
  summarizeToolCalls,
  toolBucket,
  toolBucketCounts,
  toolCallDetail,
  toolCallFallbackLabel,
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

  it("prefers path and query details over raw names", () => {
    expect(
      toolCallDetail({
        name: "read",
        input: { filePath: "apps/ui/src/features/chat/ConversationThread.tsx" },
      }),
    ).toBe("apps/ui/src/features/chat/ConversationThread.tsx")
    expect(
      toolCallDetail({
        name: "glob",
        arguments: JSON.stringify({ pattern: "**/*.md" }),
      }),
    ).toBe("**/*.md")
    expect(
      toolCallDetail({
        name: "hybrid_search",
        input: { query: "where is login documented" },
      }),
    ).toBe("where is login documented")
    expect(toolCallDetail({ name: "read" })).toBe("Read file")
    expect(toolCallDetail({ name: "glob" })).toBe("Search files")
    expect(toolCallFallbackLabel("read")).toBe("Read file")
    expect(toolCallFallbackLabel("glob")).toBe("Search files")
  })

  it("groups unique calls into collapsed chips", () => {
    const tools = summarizeToolCalls([
      {
        type: "tool-call",
        id: "tc_1",
        name: "read",
        input: { path: "knowledge/billing/ledger.md" },
      },
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
    expect(toolBucketCounts(tools)).toEqual({
      reads: 1,
      searches: 2,
      tools: 1,
    })
    expect(collapsedToolSummary(toolBucketCounts(tools))).toEqual([
      "Read 1 file",
      "2 searches",
      "Used 1 tool",
    ])
    expect(tools.map((tool) => tool.detail)).toEqual([
      "knowledge/billing/ledger.md",
      "knowledge/**/*.md",
      "billing",
      "ls",
    ])
  })
})

describe("reasoning markdown", () => {
  it("puts a heading-only line on its own block", () => {
    expect(
      normalizeReasoningMarkdown(
        "**Inspecting documentation steps**\n\nI should move forward carefully.\n**Implementing document updates**\n\nNext I will edit docker.md.",
      ),
    ).toBe(
      "**Inspecting documentation steps**\n\nI should move forward carefully.\n\n**Implementing document updates**\n\nNext I will edit docker.md.",
    )
    expect(
      normalizeReasoningMarkdown(
        "I should move forward carefully.**Implementing document updates**\nNext I will edit docker.md.",
      ),
    ).toBe(
      "I should move forward carefully.\n\n**Implementing document updates**\n\nNext I will edit docker.md.",
    )
  })

  it("returns the latest bold or ATX heading", () => {
    expect(latestReasoningHeading("I'll inspect the repository.")).toBeNull()
    expect(
      latestReasoningHeading(
        "**Inspecting documentation steps**\n\nFirst.\n**Consolidating documents**\n\nSecond.",
      ),
    ).toBe("Consolidating documents")
    expect(
      latestReasoningHeading(
        "# Inspecting\n\nBody\n## Consolidating documents",
      ),
    ).toBe("Consolidating documents")
  })
})
