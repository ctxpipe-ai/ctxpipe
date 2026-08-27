import { describe, expect, it, vi } from "vitest"
import { completePersistedWorkspaceChatRun } from "./workspace-chat-persistence.js"

describe("completePersistedWorkspaceChatRun", () => {
  it("marks the active run completed after the client saw RUN_FINISHED", async () => {
    const update = vi.fn(async () => {})
    const persistence = {
      stores: {
        runs: {
          findActiveRun: async () => ({
            runId: "run_1",
            threadId: "conv_1",
            status: "running" as const,
            startedAt: 1,
          }),
          update,
        },
      },
    }
    await completePersistedWorkspaceChatRun("conv_1", persistence)
    expect(update).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "completed" }),
    )
  })

  it("does nothing when no run is active", async () => {
    const update = vi.fn(async () => {})
    const persistence = {
      stores: {
        runs: {
          findActiveRun: async () => null,
          update,
        },
      },
    }
    await completePersistedWorkspaceChatRun("conv_1", persistence)
    expect(update).not.toHaveBeenCalled()
  })
})
