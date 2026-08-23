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
  it("keeps a single reply that equals the prompt", () => {
    expect(
      workspaceChatAssistantReply({ prompt: "hello", texts: ["hello"] }),
    ).toBe("hello")
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
  it("does not yield the leading prompt echo and persists only the last reply", () => {
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
    ).toBe("only-this-run")
    expect(assistant).toBe("only-this-run")
  })

  it("strips a same-id prompt prefix", () => {
    const { out, assistant } = runGate("hello", [
      { type: "TEXT_MESSAGE_CONTENT", messageId: "one", delta: "hello" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "one",
        delta: "only-this-run",
      },
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
    ).toBe("only-this-run")
    expect(assistant).toBe("only-this-run")
  })

  it("keeps a lone reply that matches the prompt", () => {
    const { out, assistant } = runGate("hello", [
      { type: "TEXT_MESSAGE_CONTENT", delta: "hello" },
      { type: "RUN_FINISHED" },
    ])
    expect(
      out.some(
        (chunk) =>
          (chunk as { type?: string }).type === "TEXT_MESSAGE_CONTENT" &&
          (chunk as { delta?: string }).delta === "hello",
      ),
    ).toBe(true)
    expect(assistant).toBe("hello")
  })
})
