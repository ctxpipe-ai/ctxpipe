import { describe, expect, it } from "vitest"
import { CHAT_SANDBOX_IDLE_MS, JOB_SANDBOX_IDLE_MS } from "./chat-lifecycle.js"
import {
  chatSandboxesDueForDestroy,
  jobSandboxesDueForDestroy,
} from "./sandbox-registry.js"

describe("sandbox registry GC", () => {
  it("destroys idle chat after 30 minutes and jobs after 60", () => {
    const now = new Date("2026-08-16T12:00:00.000Z")
    expect(
      chatSandboxesDueForDestroy({
        conversations: [
          {
            id: "conv_idle",
            lastMessageAt: new Date(now.getTime() - CHAT_SANDBOX_IDLE_MS),
          },
          { id: "conv_live", lastMessageAt: now },
        ],
        now,
      }),
    ).toEqual(["conv_idle"])
    expect(
      jobSandboxesDueForDestroy({
        workspaces: [
          {
            id: "ws_idle",
            lastJobAt: new Date(now.getTime() - JOB_SANDBOX_IDLE_MS),
          },
          { id: "ws_live", lastJobAt: now },
        ],
        now,
      }),
    ).toEqual(["ws_idle"])
  })
})
