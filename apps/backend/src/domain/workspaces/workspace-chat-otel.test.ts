import { describe, expect, it } from "vitest"
import {
  beginWorkspaceChatProxyGeneration,
  beginWorkspaceChatTurn,
  finishWorkspaceChatTurn,
  markWorkspaceChatFirstShownToken,
  recordWorkspaceChatProxyGeneration,
} from "./workspace-chat-otel.js"

describe("workspace chat otel turn summary", () => {
  it("records generation loops and the tool gap before the next completion", () => {
    beginWorkspaceChatTurn("conv_otel", "run_otel")
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
    markWorkspaceChatFirstShownToken("run_otel")
    const summary = finishWorkspaceChatTurn("run_otel")
    expect(summary?.loops).toBe(2)
    expect(summary?.generations.map((item) => item.finishReason)).toEqual([
      "tool_calls",
      "stop",
    ])
    expect(summary?.generations.at(-1)?.text).toBe(
      "This repo is a TypeScript monorepo.",
    )
    expect(summary?.tools.map((item) => item.name)).toEqual(["bash"])
    expect(summary?.ttftMs).toBeGreaterThanOrEqual(0)
  })

  it("keeps overlapping conversation turns on separate run ids", () => {
    beginWorkspaceChatTurn("conv_overlap", "run_a")
    recordWorkspaceChatProxyGeneration("conv_overlap", {
      ttfbMs: 10,
      durationMs: 20,
      finishReason: "stop",
      tools: [],
      text: "first",
    })
    beginWorkspaceChatTurn("conv_overlap", "run_b")
    recordWorkspaceChatProxyGeneration("conv_overlap", {
      ttfbMs: 11,
      durationMs: 21,
      finishReason: "stop",
      tools: [],
      text: "second",
    })
    const first = finishWorkspaceChatTurn("run_a")
    const second = finishWorkspaceChatTurn("run_b")
    expect(first?.generations.map((item) => item.text)).toEqual(["first"])
    expect(second?.generations.map((item) => item.text)).toEqual(["second"])
    expect(finishWorkspaceChatTurn("run_a")).toBeNull()
  })
})
