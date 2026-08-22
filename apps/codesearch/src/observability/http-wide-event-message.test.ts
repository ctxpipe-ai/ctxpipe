import { describe, expect, it } from "vitest"
import { httpWideEventMessage } from "./http-wide-event-message.js"

describe("httpWideEventMessage", () => {
  it("fills Better Stack message from method path status", () => {
    expect(
      httpWideEventMessage({
        method: "POST",
        path: "/search",
        status: 503,
      }),
    ).toBe("POST /search 503")
  })
})
