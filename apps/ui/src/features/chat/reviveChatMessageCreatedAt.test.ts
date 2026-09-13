import { describe, expect, it } from "vitest"
import { reviveChatMessages } from "./reviveChatMessageCreatedAt"

describe("reviveChatMessages", () => {
  it("turns ISO-string createdAt into a Date the wire converter can call", () => {
    const createdAt = "2026-09-13T09:00:00.000Z"
    const [message] = reviveChatMessages([{ id: "m1", createdAt }])
    expect(message?.createdAt).toBeInstanceOf(Date)
    expect(message?.createdAt?.toISOString()).toBe(createdAt)
  })

  it("drops invalid createdAt instead of leaving a non-Date", () => {
    const [message] = reviveChatMessages([
      { id: "m1", createdAt: "not-a-date" },
    ])
    expect(message).toEqual({ id: "m1" })
  })
})
