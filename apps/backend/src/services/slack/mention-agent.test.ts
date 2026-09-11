import { describe, expect, it } from "vitest"
import {
  isSlackModelConfigured,
  stripSlackMentionText,
} from "./mention-agent.js"

describe("stripSlackMentionText", () => {
  it("treats a bare mention as empty remainder", () => {
    expect(stripSlackMentionText("<@U_BOT>")).toBe("")
    expect(stripSlackMentionText("<@U_BOT>   ")).toBe("")
  })

  it("keeps intent text after the mention", () => {
    expect(stripSlackMentionText("<@U_BOT> capture this")).toBe("capture this")
  })
})

describe("isSlackModelConfigured", () => {
  it("accepts an API key or Bedrock", () => {
    expect(
      isSlackModelConfigured({ MODEL_PROVIDER_API_KEY: "sk" } as never),
    ).toBe(true)
    expect(isSlackModelConfigured({ MODEL_PROVIDER: "bedrock" } as never)).toBe(
      true,
    )
    expect(isSlackModelConfigured({} as never)).toBe(false)
  })
})
