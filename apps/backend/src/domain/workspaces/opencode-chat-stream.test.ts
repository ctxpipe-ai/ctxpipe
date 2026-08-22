import { initLogger } from "evlog"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger } from "../../observability/logger.js"
import {
  emitOpencodeChatAttempt,
  httpWideEventMessage,
  isOpencodeChatFatal,
  opencodeChatStreamEvent,
  opencodeChatStreamExcerpt,
  shouldFailEmptyChatTurn,
  stripAnsi,
  withTanstackConsoleCapture,
} from "./opencode-chat-stream.js"

describe("opencodeChatStreamEvent", () => {
  it("builds the chat-attempt wide event from an OpenCode 500", () => {
    const error = Object.assign(
      new Error("Unexpected server error. Check server logs for details."),
      { status: 500 },
    )
    expect(
      opencodeChatStreamEvent({
        conversationId: "conv_1",
        workspaceId: "ws_1",
        error,
        provider: "local-process",
        durationMs: 16890,
      }),
    ).toEqual({
      step: "opencode.chatStream",
      conversationId: "conv_1",
      workspaceId: "ws_1",
      status: 500,
      bodyExcerpt: "Unexpected server error. Check server logs for details.",
      message: "Unexpected server error. Check server logs for details.",
      provider: "local-process",
      durationMs: 16890,
    })
    expect(
      opencodeChatStreamEvent({
        conversationId: "conv_1",
        workspaceId: "ws_1",
        provider: "local-process",
        opencodePort: 4096,
      }),
    ).toMatchObject({
      step: "opencode.chatStream",
      status: 200,
      message: "OpenCode chat stream completed",
      opencodePort: 4096,
    })
  })

  it("strips ANSI and treats an empty assistant plus fatal as a failed turn", () => {
    expect(stripAnsi("\u001b[31merror\u001b[0m")).toBe("error")
    expect(
      opencodeChatStreamExcerpt("\u001b[31mUnexpected server error\u001b[0m"),
    ).toBe("Unexpected server error")
    expect(
      isOpencodeChatFatal(
        new Error("❌ [tanstack-ai:errors] ❌ opencode.chatStream fatal"),
      ),
    ).toBe(true)
    expect(
      shouldFailEmptyChatTurn({
        assistant: "",
        error: new Error("Unexpected server error"),
      }),
    ).toBe(true)
    expect(
      shouldFailEmptyChatTurn({
        assistant: "hello",
        error: new Error("Unexpected server error"),
      }),
    ).toBe(false)
  })

  it("emits a standalone chat event after the HTTP logger is sealed", () => {
    const drained: Array<Record<string, unknown>> = []
    initLogger({
      enabled: true,
      pretty: false,
      env: { service: "ctxpipe-backend-test" },
      drain: (ctx) => {
        drained.push(ctx.event as Record<string, unknown>)
      },
    })
    const request = createLogger({
      method: "POST",
      path: "/api/v1/conversations/conv_1",
    })
    request.emit()
    request.set({ step: "dropped-late-write" })
    const error = Object.assign(
      new Error("Unexpected server error. Check server logs for details."),
      { status: 500 },
    )
    emitOpencodeChatAttempt(
      opencodeChatStreamEvent({
        conversationId: "conv_1",
        workspaceId: "ws_1",
        error,
        provider: "local-process",
      }),
      error,
    )
    expect(drained.some((event) => event.step === "dropped-late-write")).toBe(
      false,
    )
    expect(
      drained.find((event) => event.step === "opencode.chatStream"),
    ).toMatchObject({
      step: "opencode.chatStream",
      conversationId: "conv_1",
      workspaceId: "ws_1",
      status: 500,
      bodyExcerpt: "Unexpected server error. Check server logs for details.",
    })
  })

  it("captures a TanStack console fatal as one error", async () => {
    const { result, fatal } = await withTanstackConsoleCapture(async () => {
      console.error("❌ [tanstack-ai:errors] ❌ opencode.chatStream fatal")
      return 1
    })
    expect(result).toBe(1)
    expect(fatal?.message).toContain("opencode.chatStream")
  })
})

afterEach(() => {
  initLogger({
    enabled: false,
    env: { service: "ctxpipe-backend-test" },
  })
})

describe("httpWideEventMessage", () => {
  it("fills Better Stack message from method path status", () => {
    expect(
      httpWideEventMessage({
        method: "POST",
        path: "/acme/api/v1/conversations/conv_1",
        status: 200,
      }),
    ).toBe("POST /acme/api/v1/conversations/conv_1 200")
  })
})
