import { describe, expect, it, vi } from "vitest"
import {
  assistantTextFromOpenCodeMessages,
  clearWorkspaceChatOpenCodeSessionId,
  loadWorkspaceChatOpenCodeSessionId,
  persistWorkspaceChatOpenCodeSessionId,
  waitForOpenCodeAssistant,
  workspaceChatOpenCodeSessionId,
} from "./workspace-chat-opencode-session.js"

describe("workspace chat OpenCode session", () => {
  it("persists and reloads the official resume session id", () => {
    const conversationId = `conv_session_${Date.now()}`
    expect(loadWorkspaceChatOpenCodeSessionId(conversationId)).toBeNull()
    persistWorkspaceChatOpenCodeSessionId(conversationId, "ses_saved")
    expect(loadWorkspaceChatOpenCodeSessionId(conversationId)).toBe("ses_saved")
    clearWorkspaceChatOpenCodeSessionId(conversationId)
    expect(loadWorkspaceChatOpenCodeSessionId(conversationId)).toBeNull()
  })

  it("reads the official session-id custom event", () => {
    expect(
      workspaceChatOpenCodeSessionId({
        type: "CUSTOM",
        name: "opencode.session-id",
        value: { sessionId: "ses_1" },
      }),
    ).toBe("ses_1")
  })

  it("ignores echo-only assistant messages", () => {
    expect(
      assistantTextFromOpenCodeMessages(
        [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "hello" }],
          },
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "hello" }],
          },
        ],
        "hello",
      ),
    ).toBe("")
  })

  it("returns late assistant text once the session has it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              info: { role: "assistant" },
              parts: [{ type: "step-start" }],
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "pong-1" }],
            },
          ]),
          { status: 200 },
        ),
      )
    await expect(
      waitForOpenCodeAssistant({
        port: 4096,
        sessionId: "ses_1",
        prompt: "ping-1",
        timeoutMs: 200,
        pollMs: 5,
        fetch: fetchMock,
      }),
    ).resolves.toBe("pong-1")
  })

  it("keeps polling past a planning preamble", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              info: { role: "assistant" },
              parts: [
                {
                  type: "text",
                  text: "I’ll inspect the repository structure and its primary project metadata to summarize its purpose and components.",
                },
              ],
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "This repo is a TypeScript app." }],
            },
          ]),
          { status: 200 },
        ),
      )
    await expect(
      waitForOpenCodeAssistant({
        port: 4096,
        sessionId: "ses_1",
        prompt: "what's in this repo?",
        timeoutMs: 200,
        pollMs: 5,
        fetch: fetchMock,
      }),
    ).resolves.toBe("This repo is a TypeScript app.")
  })
})
