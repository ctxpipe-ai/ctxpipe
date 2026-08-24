import { describe, expect, test } from "vitest"
import { workspaceChatHttpPath } from "./chatConnection"

describe("workspaceChatHttpPath", () => {
  test("builds the org-scoped conversation chat POST path", () => {
    expect(workspaceChatHttpPath("acme", "conv_1")).toBe(
      "/acme/api/v1/conversations/conv_1",
    )
  })
})
