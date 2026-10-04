import type { StreamChunk } from "@tanstack/ai"
import { describe, expect, it } from "vitest"
import {
  sandboxPhaseFromChunk,
  workspaceChatHasAssistantText,
  workspaceChatWaitLabel,
} from "./WorkspaceChatSession"

describe("workspace chat wait copy", () => {
  it("defaults to Thinking and only names the sandbox while it is starting", () => {
    expect(workspaceChatWaitLabel("idle")).toBe("Thinking…")
    expect(workspaceChatWaitLabel("ready")).toBe("Thinking…")
    expect(workspaceChatWaitLabel("starting")).toBe("Setting up sandbox")
  })

  it("reads sandbox-setup CUSTOM chunks and ignores other events", () => {
    expect(
      sandboxPhaseFromChunk({
        type: "CUSTOM",
        name: "sandbox-setup",
        value: { phase: "starting" },
        timestamp: 1,
      } as StreamChunk),
    ).toBe("starting")
    expect(
      sandboxPhaseFromChunk({
        type: "CUSTOM",
        name: "sandbox-setup",
        value: { phase: "ready" },
        timestamp: 1,
      } as StreamChunk),
    ).toBe("ready")
    expect(
      sandboxPhaseFromChunk({
        type: "CUSTOM",
        name: "rename-conversation",
        value: { name: "Ledger" },
        timestamp: 1,
      } as StreamChunk),
    ).toBeNull()
    expect(
      sandboxPhaseFromChunk({
        type: "RUN_STARTED",
        threadId: "conv_1",
        runId: "run_1",
        timestamp: 1,
      } as StreamChunk),
    ).toBeNull()
  })
})

describe("workspace chat assistant text", () => {
  it("ignores empty and whitespace assistant parts", () => {
    expect(
      workspaceChatHasAssistantText([
        { role: "user", parts: [{ type: "text", content: "hello" }] },
      ]),
    ).toBe(false)
    expect(
      workspaceChatHasAssistantText([
        { role: "assistant", parts: [{ type: "text", content: "  " }] },
      ]),
    ).toBe(false)
    expect(
      workspaceChatHasAssistantText([
        { role: "assistant", parts: [{ type: "text", content: "Hi" }] },
      ]),
    ).toBe(true)
  })
})
