import { describe, expect, it } from "vitest"
import {
  conversationStatus,
  conversationStatusLabel,
  isLiveRun,
} from "./conversationStatus"

describe("conversationStatus", () => {
  it("is idle for a chat with no turn", () => {
    expect(conversationStatus(null, undefined)).toBe("idle")
    expect(conversationStatus(undefined, 5)).toBe("idle")
  })

  it("is working while the newest turn runs", () => {
    expect(conversationStatus({ status: "running", at: 10 }, 99, 20)).toBe(
      "working",
    )
  })

  it("stops working once a running turn passes the backend turn limit", () => {
    const limit = 2 * 60 * 60_000
    const turn = { status: "running", at: 1000 } as const
    expect(conversationStatus(turn, undefined, 1000 + limit)).toBe("working")
    expect(isLiveRun(turn, 1000 + limit)).toBe(true)
    expect(conversationStatus(turn, undefined, 1000 + limit + 1)).toBe(
      "attention",
    )
    expect(isLiveRun(turn, 1000 + limit + 1)).toBe(false)
  })

  it("needs attention when the newest turn failed, stopped, or waits", () => {
    for (const status of ["failed", "aborted", "interrupted"] as const) {
      expect(conversationStatus({ status, at: 10 }, 99)).toBe("attention")
    }
  })

  it("is unread when a turn finished after the last time the user saw the chat", () => {
    expect(conversationStatus({ status: "completed", at: 10 }, 5)).toBe(
      "unread",
    )
    expect(conversationStatus({ status: "completed", at: 10 }, 10)).toBe("idle")
  })

  it("treats a chat that this browser never saw as read", () => {
    expect(conversationStatus({ status: "completed", at: 10 }, undefined)).toBe(
      "idle",
    )
  })

  it("gives each attention cause its own words", () => {
    const label = (status: "failed" | "aborted" | "interrupted") =>
      conversationStatusLabel("attention", { status, at: 1 })
    expect(label("failed")).toContain("failed")
    expect(label("aborted")).toContain("stopped")
    expect(label("interrupted")).toContain("waits for you")
  })
})
