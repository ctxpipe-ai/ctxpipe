import { describe, expect, it } from "vitest"
import {
  createWorkspaceChatAssistantGate,
  isOpenCodePlanningHold,
  workspaceChatAssistantReply,
} from "./workspace-chat-assistant-text.js"

function runGate(prompt: string, chunks: object[]) {
  const gate = createWorkspaceChatAssistantGate(prompt)
  const out: object[] = []
  for (const chunk of chunks) out.push(...gate.take(chunk))
  out.push(...gate.flush())
  return { out, assistant: gate.assistant() }
}

function textDeltas(chunks: object[]): string {
  return chunks
    .filter((chunk) => (chunk as { type?: string }).type === "TEXT_MESSAGE_CONTENT")
    .map((chunk) => (chunk as { delta?: string }).delta ?? "")
    .join("")
}

describe("workspaceChatAssistantReply", () => {
  it("treats echo-only text as an empty persist reply", () => {
    expect(
      workspaceChatAssistantReply({ prompt: "hello", texts: ["hello"] }),
    ).toBe("")
  })

  it("drops a leading prompt echo when a later text message exists", () => {
    expect(
      workspaceChatAssistantReply({
        prompt: "hello",
        texts: ["hello", "only-this-run"],
      }),
    ).toBe("only-this-run")
  })

  it("strips a same-message prompt prefix", () => {
    expect(
      workspaceChatAssistantReply({
        prompt: "hello",
        texts: ["helloonly-this-run"],
      }),
    ).toBe("only-this-run")
  })
})

describe("createWorkspaceChatAssistantGate", () => {
  it("does not stream a leading prompt echo", () => {
    const { out, assistant } = runGate("hello", [
      { type: "TEXT_MESSAGE_START", messageId: "user-part" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "user-part", delta: "hello" },
      { type: "TEXT_MESSAGE_END", messageId: "user-part" },
      { type: "TEXT_MESSAGE_START", messageId: "asst" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "asst",
        delta: "only-this-run",
      },
      { type: "TEXT_MESSAGE_END", messageId: "asst" },
      { type: "RUN_FINISHED" },
    ])
    expect(textDeltas(out)).toBe("only-this-run")
    expect(out.some((chunk) => (chunk as { type?: string }).type === "RUN_FINISHED")).toBe(
      true,
    )
    expect(assistant).toBe("only-this-run")
  })

  it("does not stream a Previous conversation leftover", () => {
    const prompt = "Now reply with only the word pong2"
    const { out, assistant } = runGate(prompt, [
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "echo",
        delta: `Previous conversation:\nUser: pong\n\n${prompt}`,
      },
      { type: "TEXT_MESSAGE_END", messageId: "echo" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "asst",
        delta: "pong2",
      },
      { type: "TEXT_MESSAGE_END", messageId: "asst" },
      { type: "RUN_FINISHED" },
    ])
    expect(textDeltas(out)).toBe("pong2")
    expect(assistant).toBe("pong2")
  })

  it("yields a first real text delta before RUN_FINISHED", () => {
    const gate = createWorkspaceChatAssistantGate("hello")
    const first = gate.take({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "asst",
      delta: "pong",
    })
    expect(textDeltas(first)).toBe("pong")
    expect(gate.take({ type: "RUN_FINISHED" })).toEqual([])
    expect(gate.flush()).toEqual([{ type: "RUN_FINISHED" }])
    expect(gate.assistant()).toBe("pong")
  })

  it("does not persist echo-only text", () => {
    const { out, assistant } = runGate("hello", [
      { type: "TEXT_MESSAGE_CONTENT", delta: "hello" },
      { type: "RUN_FINISHED" },
    ])
    expect(textDeltas(out)).toBe("")
    expect(assistant).toBe("")
  })

  it("strips a same-message prompt prefix from the live stream", () => {
    const { out, assistant } = runGate("hello", [
      { type: "TEXT_MESSAGE_CONTENT", messageId: "asst", delta: "hello" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "asst", delta: "only-this-run" },
      { type: "TEXT_MESSAGE_END", messageId: "asst" },
      { type: "RUN_FINISHED" },
    ])
    expect(textDeltas(out)).toBe("only-this-run")
    expect(assistant).toBe("only-this-run")
  })

  it("drops a sandbox directory tool dump", () => {
    const dump =
      "<path>/tmp/tanstack-ai-sandboxes/e9292094-fc12-424c-b789-c8be901b85f9/tmp/tanstack-ai-sandboxes/e9292094-fc12-424c-b789-c8be901b85f9</path>\n<type>directory</type>\n<entries>\n.tanstack-projected-6f87aac353f2008d\n\n(1 entries)\n</entries>"
    const { out, assistant } = runGate("what's in this repo?", [
      { type: "TEXT_MESSAGE_CONTENT", messageId: "dump", delta: dump },
      { type: "TEXT_MESSAGE_END", messageId: "dump" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "asst", delta: "pong" },
      { type: "TEXT_MESSAGE_END", messageId: "asst" },
      { type: "RUN_FINISHED" },
    ])
    expect(textDeltas(out)).toBe("pong")
    expect(assistant).toBe("pong")
  })

  it("does not persist a planning preamble as the reply", () => {
    expect(
      isOpenCodePlanningHold(
        "I’ll inspect the repository structure and its primary project metadata to summarize its purpose and components.",
      ),
    ).toBe(true)
    expect(
      workspaceChatAssistantReply({
        prompt: "what's in this repo?",
        texts: [
          "I’ll inspect the repository structure and its primary project metadata to summarize its purpose and components.",
        ],
      }),
    ).toBe("")
    expect(
      workspaceChatAssistantReply({
        prompt: "what's in this repo?",
        texts: [
          "I’ll inspect the repository structure and its primary project metadata to summarize its purpose and components.",
          "This repo is a TypeScript monorepo.",
        ],
      }),
    ).toBe("This repo is a TypeScript monorepo.")
  })

  it("drops leftover TanStack / OpenCode log text", () => {
    expect(
      workspaceChatAssistantReply({
        prompt: "hello",
        texts: ["hello", "OpenCode chat stream completed"],
      }),
    ).toBe("")
    expect(
      workspaceChatAssistantReply({
        prompt: "ping-1",
        texts: ["Previous conversation:\nUser: ping-1\n"],
      }),
    ).toBe("")
  })
})
