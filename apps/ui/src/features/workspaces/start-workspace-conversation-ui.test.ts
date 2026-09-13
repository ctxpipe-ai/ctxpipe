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
} from "./start-workspace-conversation-ui"
import { docsWorkspace } from "./workspace-fixtures"

const server = setupServer()
const conversationId = "conv_0123456789abcdef0123456789abcdef"

function listenForConversationHttp(
  onCreate: (request: Request) => Promise<Response> | Response,
) {
  server.use(
    http.post(
      ({ request }) =>
        /\/api\/v1\/conversations\/?$/.test(
          new URL(request.url, "http://localhost").pathname,
        ),
      ({ request }) => onCreate(request),
    ),
    http.get(
      ({ request }) =>
        /\/api\/v1\/conversations\/[^/]+$/.test(
          new URL(request.url, "http://localhost").pathname,
        ),
      () => HttpResponse.json({ error: "not found" }, { status: 404 }),
    ),
    http.get(
      ({ request }) =>
        /\/api\/v1\/workspaces\/[^/]+$/.test(
          new URL(request.url, "http://localhost").pathname,
        ),
      () => HttpResponse.json(docsWorkspace),
    ),
  )
}

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
      conversationId,
      text: "What is hydrate status?",
    })
    expect(detail.messages[0]?.parts[0]).toMatchObject({
      type: "text",
      content: "What is hydrate status?",
    })
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

  it("selects nav and navigates before the POST settles", async () => {
    const queryClient = new QueryClient()
    const selectNav = vi.fn()
    const navigate = vi.fn().mockResolvedValue(undefined)
    let releasePost!: () => void
    const postHeld = new Promise<void>((resolve) => {
      releasePost = resolve
    })
    let createSettled = false
    listenForConversationHttp(async () => {
      await postHeld
      createSettled = true
      return new HttpResponse(
        'data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n',
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-conversation-id": conversationId,
          },
        },
      )
    })
    const opened = openWorkspaceConversation({
      queryClient,
      navigate: navigate as never,
      selectNav,
      orgSlug: "acme",
      workspace: { id: "ws_1", slug: "docs" },
      text: "What is hydrate status?",
      conversationId,
      idempotencyKey: conversationId,
    })
    expect(selectNav).toHaveBeenCalledWith({
      orgSlug: "acme",
      primary: "workspace",
      workspaceSlug: "docs",
      conversationId,
    })
    expect(navigate).toHaveBeenCalled()
    expect(createSettled).toBe(false)
    releasePost()
    await expect(opened).resolves.toEqual({ conversationId })
    expect(createSettled).toBe(true)
  })
})
