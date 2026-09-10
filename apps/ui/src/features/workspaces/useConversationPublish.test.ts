import { describe, expect, it } from "vitest"
import {
  conversationCreatePrMutationKey,
  conversationPushMutationKey,
} from "./useConversationPublish"

describe("conversation publish mutation keys", () => {
  it("scopes push and pull-request commands to the conversation", () => {
    expect(conversationPushMutationKey("acme", "conv_1")).toEqual([
      "conversation-push",
      "acme",
      "conv_1",
    ])
    expect(conversationCreatePrMutationKey("acme", "conv_1")).toEqual([
      "conversation-create-pr",
      "acme",
      "conv_1",
    ])
    expect(conversationPushMutationKey("acme", "conv_1")).not.toEqual(
      conversationPushMutationKey("acme", "conv_2"),
    )
  })
})
