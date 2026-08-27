import { describe, expect, it } from "vitest"
import {
  addOptimisticConversationTreePath,
  conversationChatRunIsLive,
  conversationToolLooksLikeWrite,
  conversationTreeRefetchInterval,
  conversationWriteFromStreamChunk,
  conversationWritePathFromBash,
  conversationWriteToolPaths,
  conversationWriteToolSignature,
} from "./conversationFileLive"

describe("conversationWriteToolPaths", () => {
  it("collects write and edit tool paths", () => {
    expect(
      conversationWriteToolPaths([
        {
          parts: [
            {
              type: "tool-call",
              name: "write",
              input: { path: "knowledge/billing/ledger.md" },
            },
            {
              type: "tool-call",
              name: "hybrid_search",
              input: { query: "billing" },
            },
            {
              type: "tool-call",
              name: "grep",
              input: { path: "AGENTS.md" },
            },
            {
              type: "tool-call",
              name: "edit",
              input: { filePath: "AGENTS.md" },
            },
          ],
        },
      ]),
    ).toEqual(["knowledge/billing/ledger.md", "AGENTS.md"])
  })

  it("extracts a bash printf redirect", () => {
    expect(
      conversationWriteToolPaths([
        {
          parts: [
            {
              type: "tool-call",
              name: "bash",
              input: { command: "printf 'sandbox\\n' > e2e.md" },
            },
          ],
        },
      ]),
    ).toEqual(["e2e.md"])
  })

  it("fingerprints the write set", () => {
    expect(
      conversationWriteToolSignature([
        {
          parts: [
            {
              type: "tool-call",
              name: "apply_patch",
              input: { path: "README.md" },
            },
          ],
        },
      ]),
    ).toBe("README.md")
  })

  it("fingerprints unparsed bash so the tree still refreshes", () => {
    expect(
      conversationWriteToolSignature([
        {
          parts: [
            {
              type: "tool-call",
              name: "bash",
              input: { command: "python3 -c 'open(\"x\",\"w\")'" },
            },
          ],
        },
      ]),
    ).toBe("bash:python3 -c 'open(\"x\",\"w\")'")
  })
})

describe("conversationWritePathFromBash", () => {
  it("parses redirect, tee, and touch destinations", () => {
    expect(conversationWritePathFromBash("printf 'x\\n' > e2e.md")).toBe(
      "e2e.md",
    )
    expect(conversationWritePathFromBash("echo hi >> notes/a.md")).toBe(
      "notes/a.md",
    )
    expect(conversationWritePathFromBash("echo hi | tee tmp-out.md")).toBe(
      "tmp-out.md",
    )
    expect(conversationWritePathFromBash("touch 'quoted file.md'")).toBe(
      "quoted file.md",
    )
  })

  it("rejects absolute and harness paths", () => {
    expect(conversationWritePathFromBash("printf x > /tmp/out.md")).toBeNull()
    expect(conversationWritePathFromBash("printf x > opencode.json")).toBeNull()
    expect(conversationWritePathFromBash("ls AGENTS.md")).toBeNull()
  })
})

describe("conversationWriteFromStreamChunk", () => {
  it("adds a write path when TOOL_CALL_ARGS complete", () => {
    const pending = new Map()
    conversationWriteFromStreamChunk(pending, {
      type: "TOOL_CALL_START",
      toolCallId: "t1",
      toolCallName: "write",
    })
    const mid = conversationWriteFromStreamChunk(pending, {
      type: "TOOL_CALL_ARGS",
      toolCallId: "t1",
      delta: '{"path":"live.md"}',
    })
    expect(mid.path).toBe("live.md")
    expect(mid.writeEnded).toBe(false)
    const ended = conversationWriteFromStreamChunk(pending, {
      type: "TOOL_CALL_END",
      toolCallId: "t1",
      input: { path: "live.md" },
    })
    expect(ended.path).toBe("live.md")
    expect(ended.writeEnded).toBe(true)
  })

  it("does not treat grep as a write end", () => {
    const pending = new Map()
    conversationWriteFromStreamChunk(pending, {
      type: "TOOL_CALL_START",
      toolCallId: "g1",
      toolCallName: "grep",
    })
    const ended = conversationWriteFromStreamChunk(pending, {
      type: "TOOL_CALL_END",
      toolCallId: "g1",
      input: { path: "AGENTS.md" },
    })
    expect(ended.path).toBeNull()
    expect(ended.writeEnded).toBe(false)
  })
})

describe("addOptimisticConversationTreePath", () => {
  it("inserts a missing path without dropping the snapshot", () => {
    expect(
      addOptimisticConversationTreePath(
        {
          sha: "abc",
          branch: "ctxpipe/chat/conv_1/1",
          paths: ["AGENTS.md"],
        },
        "e2e.md",
        { sha: "HEAD", branch: "ctxpipe/chat/conv_1/1" },
      ).paths,
    ).toEqual(["AGENTS.md", "e2e.md"])
  })
})

describe("conversationChatRunIsLive", () => {
  it("is live only while submitted or streaming", () => {
    expect(conversationChatRunIsLive("submitted")).toBe(true)
    expect(conversationChatRunIsLive("streaming")).toBe(true)
    expect(conversationChatRunIsLive("ready")).toBe(false)
    expect(conversationToolLooksLikeWrite("grep")).toBe(false)
  })

  it("polls every 400ms only while the run is live", () => {
    const live = conversationTreeRefetchInterval(true)
    const idle = conversationTreeRefetchInterval(false)
    expect(live({ state: { data: { paths: ["AGENTS.md"] } } })).toBe(400)
    expect(idle({ state: { data: { paths: ["AGENTS.md"] } } })).toBe(false)
    expect(idle({ state: {} })).toBe(2000)
  })
})
