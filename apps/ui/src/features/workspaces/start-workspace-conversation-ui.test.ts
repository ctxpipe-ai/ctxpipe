import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import * as queries from "./queries"
import { workspaceKeys } from "./queries"
import {
  newUiConversationId,
  openWorkspaceConversation,
  seedWorkspaceConversation,
  seedWorkspaceDetailFromList,
} from "./start-workspace-conversation-ui"
import { docsWorkspace } from "./workspace-fixtures"

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

describe("seedWorkspaceDetailFromList", () => {
  it("copies the list workspace so the surface can render without waiting on detail", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.list("acme"), {
      lastUsedWorkspaceId: docsWorkspace.id,
      items: [docsWorkspace],
    })
    const seeded = seedWorkspaceDetailFromList({
      queryClient,
      orgSlug: "acme",
      workspace: { id: docsWorkspace.id, slug: docsWorkspace.slug },
    })
    expect(seeded).toMatchObject({
      slug: "docs",
      linkedRepositories: [],
    })
    expect(
      queryClient.getQueryData(workspaceKeys.detail("acme", "docs")),
    ).toEqual(seeded)
  })

  it("does not replace a workspace detail that is already cached", () => {
    const queryClient = new QueryClient()
    const cached = { ...docsWorkspace, linkedRepositories: [] }
    queryClient.setQueryData(workspaceKeys.detail("acme", "docs"), cached)
    queryClient.setQueryData(workspaceKeys.list("acme"), {
      lastUsedWorkspaceId: docsWorkspace.id,
      items: [{ ...docsWorkspace, displayName: "Other" }],
    })
    expect(
      seedWorkspaceDetailFromList({
        queryClient,
        orgSlug: "acme",
        workspace: { id: docsWorkspace.id, slug: docsWorkspace.slug },
      }),
    ).toEqual(cached)
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
