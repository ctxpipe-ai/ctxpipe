import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import * as queries from "./queries"
import { workspaceKeys } from "./queries"
import {
  newUiConversationId,
  openWorkspaceConversation,
  seedWorkspaceConversation,
} from "./start-workspace-conversation-ui"

describe("newUiConversationId", () => {
  it("returns a conv_ hex id the server will accept", () => {
    expect(newUiConversationId()).toMatch(/^conv_[a-f0-9]{32}$/)
  })
})

describe("seedWorkspaceConversation", () => {
  it("writes the user bubble and list row before navigate", () => {
    const queryClient = new QueryClient()
    const detail = seedWorkspaceConversation({
      queryClient,
      orgSlug: "acme",
      workspaceId: "ws_1",
      conversationId: "conv_0123456789abcdef0123456789abcdef",
      text: "What is hydrate status?",
    })
    expect(detail.messages[0]?.parts[0]).toMatchObject({
      type: "text",
      content: "What is hydrate status?",
    })
    expect(
      queryClient.getQueryData(
        workspaceKeys.conversation(
          "acme",
          "conv_0123456789abcdef0123456789abcdef",
          "ws_1",
        ),
      ),
    ).toEqual(detail)
  })
})

describe("openWorkspaceConversation", () => {
  it("selects nav and navigates before the POST settles", async () => {
    const queryClient = new QueryClient()
    const selectNav = vi.fn()
    const navigate = vi.fn().mockResolvedValue(undefined)
    let releasePost!: (value: { conversationId: string }) => void
    const post = new Promise<{ conversationId: string }>((resolve) => {
      releasePost = resolve
    })
    vi.spyOn(queries, "startWorkspaceConversation").mockReturnValue(post)
    vi.spyOn(queries, "fetchConversation").mockResolvedValue(null)
    const opened = openWorkspaceConversation({
      queryClient,
      navigate: navigate as never,
      selectNav,
      orgSlug: "acme",
      workspace: { id: "ws_1", slug: "docs" },
      text: "What is hydrate status?",
      conversationId: "conv_0123456789abcdef0123456789abcdef",
      idempotencyKey: "conv_0123456789abcdef0123456789abcdef",
    })
    expect(selectNav).toHaveBeenCalledWith({
      orgSlug: "acme",
      primary: "workspace",
      workspaceSlug: "docs",
      conversationId: "conv_0123456789abcdef0123456789abcdef",
    })
    expect(navigate).toHaveBeenCalled()
    releasePost({ conversationId: "conv_0123456789abcdef0123456789abcdef" })
    await expect(opened).resolves.toEqual({
      conversationId: "conv_0123456789abcdef0123456789abcdef",
    })
  })
})
