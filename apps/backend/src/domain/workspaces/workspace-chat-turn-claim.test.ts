import { describe, expect, it, vi } from "vitest"
import { workspaceChatStreamResponse } from "../conversations/transport.js"
import {
  claimWorkspaceChatTurn,
  resetWorkspaceChatTurnClaims,
  workspaceChatTurnIsBusy,
} from "./workspace-chat-turn-claim.js"

describe("claimWorkspaceChatTurn", () => {
  it("allows one active turn per conversation and many conversations at once", () => {
    resetWorkspaceChatTurnClaims()
    const first = claimWorkspaceChatTurn("conv_a")
    const overlap = claimWorkspaceChatTurn("conv_a")
    const other = claimWorkspaceChatTurn("conv_b")
    expect(first).not.toBeNull()
    expect(overlap).toBeNull()
    expect(other).not.toBeNull()
    expect(workspaceChatTurnIsBusy("conv_a")).toBe(true)
    first?.release()
    expect(workspaceChatTurnIsBusy("conv_a")).toBe(false)
    expect(claimWorkspaceChatTurn("conv_a")).not.toBeNull()
    resetWorkspaceChatTurnClaims()
  })

  it("lets a new turn start after a stale claim expires", () => {
    resetWorkspaceChatTurnClaims()
    const first = claimWorkspaceChatTurn("conv_stale")
    expect(first).not.toBeNull()
    vi.useFakeTimers()
    vi.advanceTimersByTime(15 * 60 * 1000 + 1)
    expect(workspaceChatTurnIsBusy("conv_stale")).toBe(false)
    expect(claimWorkspaceChatTurn("conv_stale")).not.toBeNull()
    vi.useRealTimers()
    resetWorkspaceChatTurnClaims()
  })

  it("releases a pre-claimed turn when the stream cannot start", async () => {
    resetWorkspaceChatTurnClaims()
    const claim = claimWorkspaceChatTurn("conv_leak")
    expect(claim).not.toBeNull()
    const res = workspaceChatStreamResponse({
      conversationId: "conv_leak",
      checkpointNamespace: "",
      prompt: "hello",
      acceptedTurn: claim ?? undefined,
      orgId: "org_1",
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "workspace_required" })
    expect(workspaceChatTurnIsBusy("conv_leak")).toBe(false)
    expect(claimWorkspaceChatTurn("conv_leak")).not.toBeNull()
    resetWorkspaceChatTurnClaims()
  })
})
