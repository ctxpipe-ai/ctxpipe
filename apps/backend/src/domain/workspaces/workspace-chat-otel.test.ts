import { describe, expect, it } from "vitest"
import {
  beginWorkspaceChatProxyGeneration,
  beginWorkspaceChatTurn,
  finishWorkspaceChatTurn,
  lastWorkspaceChatStopText,
  markWorkspaceChatFirstShownToken,
  recordWorkspaceChatProxyGeneration,
} from "./workspace-chat-otel.js"

describe("workspace chat otel turn summary", () => {
  it("records generation loops and the tool gap before the next completion", () => {
    beginWorkspaceChatTurn("conv_otel")
    recordWorkspaceChatProxyGeneration("conv_otel", {
      ttfbMs: 80,
      durationMs: 200,
      finishReason: "tool_calls",
      tools: ["bash"],
    })
    beginWorkspaceChatProxyGeneration("conv_otel")
    recordWorkspaceChatProxyGeneration("conv_otel", {
      ttfbMs: 40,
      durationMs: 90,
      finishReason: "stop",
      tools: [],
      text: "This repo is a TypeScript monorepo.",
    })
    expect(lastWorkspaceChatStopText("conv_otel")).toBe(
      "This repo is a TypeScript monorepo.",
    )
    markWorkspaceChatFirstShownToken("conv_otel")
    const summary = finishWorkspaceChatTurn("conv_otel")
    expect(summary?.loops).toBe(2)
    expect(summary?.generations.map((item) => item.finishReason)).toEqual([
      "tool_calls",
      "stop",
    ])
    expect(summary?.tools.map((item) => item.name)).toEqual(["bash"])
    expect(summary?.ttftMs).toBeGreaterThanOrEqual(0)
  })
})
