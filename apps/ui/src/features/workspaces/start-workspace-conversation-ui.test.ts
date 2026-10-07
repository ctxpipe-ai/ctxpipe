import { QueryClient } from "@tanstack/react-query"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { workspaceKeys } from "./queries"
import { installMemorySessionStorage } from "./session-storage-test"
import {
  newUiConversationId,
  openWorkspaceConversation,
  seedWorkspaceConversation,
  seedWorkspaceDetailFromList,
  takeFirstMessage,
} from "./start-workspace-conversation-ui"
import { docsWorkspace } from "./workspace-fixtures"

const server = setupServer()
const conversationId = "conv_0123456789abcdef0123456789abcdef"

describe("newUiConversationId", () => {
  it("returns a conv_ hex id the server will accept", () => {
    expect(newUiConversationId()).toMatch(/^conv_[a-f0-9]{32}$/)
  })
})

describe("seedWorkspaceConversation", () => {
  it("writes an empty transcript and the list row before navigate", () => {
    const queryClient = new QueryClient()
    const detail = seedWorkspaceConversation({
      queryClient,
      orgSlug: "acme",
      workspaceId: "ws_1",
      conversationId,
    })
    expect(detail.messages).toEqual([])
    expect(
      queryClient.getQueryData(
        workspaceKeys.conversation("acme", conversationId, "ws_1"),
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
  beforeAll(() => {
    installMemorySessionStorage()
    server.listen({ onUnhandledRequest: "error" })
    const intercepted = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const next =
        typeof input === "string" && input.startsWith("/")
          ? `http://localhost${input}`
          : input
      return intercepted(next as RequestInfo, init)
    }) as typeof fetch
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
  })

  it("hands the first message to the conversation once and navigates to it", () => {
    const queryClient = new QueryClient()
    const selectNav = vi.fn()
    const navigate = vi.fn().mockResolvedValue(undefined)
    server.use(
      http.get(/\/api\/v1\/workspaces\/[^/]+$/, () =>
        HttpResponse.json(docsWorkspace),
      ),
    )
    openWorkspaceConversation({
      queryClient,
      navigate: navigate as never,
      selectNav,
      orgSlug: "acme",
      workspace: { id: "ws_1", slug: "docs" },
      text: "What is hydrate status?",
    })
    const opened = navigate.mock.calls[0]?.[0]?.params?.conversationId
    expect(opened).toMatch(/^conv_[a-f0-9]{32}$/)
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
        params: {
          orgSlug: "acme",
          workspaceSlug: "docs",
          conversationId: opened,
        },
      }),
    )
    expect(selectNav).toHaveBeenCalledWith({
      orgSlug: "acme",
      primary: "workspace",
      workspaceSlug: "docs",
      conversationId: opened,
    })
    expect(takeFirstMessage(queryClient, "acme", opened)).toBe(
      "What is hydrate status?",
    )
    expect(takeFirstMessage(queryClient, "acme", opened)).toBeUndefined()
  })
})
