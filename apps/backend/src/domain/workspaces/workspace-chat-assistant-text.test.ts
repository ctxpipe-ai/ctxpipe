import { describe, expect, it } from "vitest"
import {
  createWorkspaceChatAssistantGate,
  workspaceChatAssistantReply,
} from "./workspace-chat-assistant-text.js"

function runGate(prompt: string, chunks: object[]) {
  const gate = createWorkspaceChatAssistantGate(prompt)
  const out: object[] = []
  for (const chunk of chunks) out.push(...gate.take(chunk))
  out.push(...gate.flush())
  return { out, assistant: gate.assistant() }
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
  it("yields text live and persists only the last reply", () => {
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
    expect(
      out
        .filter(
          (chunk) =>
            (chunk as { type?: string }).type === "TEXT_MESSAGE_CONTENT",
        )
        .map((chunk) => (chunk as { delta?: string }).delta)
        .join(""),
    ).toBe("helloonly-this-run")
    expect(out.some((chunk) => (chunk as { type?: string }).type === "RUN_FINISHED")).toBe(
      true,
    )
    expect(assistant).toBe("only-this-run")
  })

  it("yields a first text delta before RUN_FINISHED", () => {
    const gate = createWorkspaceChatAssistantGate("hello")
    const first = gate.take({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "asst",
      delta: "pong",
    })
    expect(first).toEqual([
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "asst",
        delta: "pong",
      },
    ])
    expect(gate.take({ type: "RUN_FINISHED" })).toEqual([])
    expect(gate.flush()).toEqual([{ type: "RUN_FINISHED" }])
    expect(gate.assistant()).toBe("pong")
  })

  it("does not persist echo-only text", () => {
    const { assistant } = runGate("hello", [
      { type: "TEXT_MESSAGE_CONTENT", delta: "hello" },
      { type: "RUN_FINISHED" },
    ])
    expect(assistant).toBe("")
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
