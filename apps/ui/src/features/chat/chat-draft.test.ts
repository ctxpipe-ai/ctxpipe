import { beforeEach, describe, expect, it } from "vitest"
import { installMemorySessionStorage } from "@/features/workspaces/session-storage-test"
import { chatDraftKey, readChatDraft, writeChatDraft } from "./chat-draft"

describe("chat draft storage", () => {
  beforeEach(() => {
    installMemorySessionStorage().clear()
  })

  it("keys a draft by org, workspace, and conversation", () => {
    expect(chatDraftKey("acme", "ws_1", "conv_1")).toBe(
      "ctxpipe.chat-draft.acme.ws_1.conv_1",
    )
    expect(chatDraftKey("acme", "ws_1")).toBe(
      "ctxpipe.chat-draft.acme.ws_1.compose",
    )
  })

  it("round-trips text and removes the entry when the text is empty", () => {
    const key = chatDraftKey("acme", "ws_1", "conv_1")
    expect(readChatDraft(key)).toBe("")
    writeChatDraft(key, "What changed this week?")
    expect(readChatDraft(key)).toBe("What changed this week?")
    writeChatDraft(key, "")
    expect(readChatDraft(key)).toBe("")
    expect(sessionStorage.getItem(key)).toBeNull()
  })
})
