import { describe, expect, it } from "vitest"
import { conversationCreatePrMutationKey } from "./useConversationPublish"

describe("conversation publish mutation keys", () => {
  it("scopes the pull-request command to the conversation", () => {
    expect(conversationCreatePrMutationKey("acme", "conv_1")).toEqual([
      "conversation-create-pr",
      "acme",
      "conv_1",
    ])
    expect(conversationCreatePrMutationKey("acme", "conv_1")).not.toEqual(
      conversationCreatePrMutationKey("acme", "conv_2"),
    )
  })
})
