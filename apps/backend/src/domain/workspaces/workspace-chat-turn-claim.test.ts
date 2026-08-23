import { describe, expect, it } from "vitest"
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
})
