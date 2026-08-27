import { QueryClient } from "@tanstack/react-query"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  clearAllConversationGitTreeSnapshots,
  readConversationGitTreeSnapshot,
  writeConversationGitTreeSnapshot,
} from "./conversation-git-tree-snapshot"
import { installMemorySessionStorage } from "./session-storage-test"
import {
  conversationGitTreeOptions,
  deleteWorkspace,
  fetchWorkspaceGitTree,
  landingWorkspace,
  retryPrepareWorkspace,
  workspaceGitTreeOptions,
  workspaceKeys,
} from "./queries"
import type { Workspace, WorkspaceListResponse } from "./types"
import { failedHydrateWorkspace } from "./workspace-fixtures"

function ws(id: string, slug: string): Workspace {
  return {
    id,
    orgId: "org_1",
    slug,
    displayName: slug,
    workspaceRepositoryUrl: `https://github.com/acme/${slug}`,
    githubConnectionId: null,
    desiredGeneration: 1,
    desiredSha: null,
    activeProjectionUrl: null,
    activeProjectionSha: null,
    indexedSha: null,
    writeStatus: "unknown",
    hydrateStatus: "pending",
    hydrateError: null,
    readOnlyReason: null,
    mostRecentConversationId: null,
    migrationExportSha: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  }
}

describe("landingWorkspace", () => {
  it("returns null when the org has none", () => {
    const list: WorkspaceListResponse = {
      lastUsedWorkspaceId: null,
      items: [],
    }
    expect(landingWorkspace(list)).toBeNull()
  })

  it("prefers last-used when it still exists", () => {
    const a = ws("ws_a", "alpha")
    const b = ws("ws_b", "beta")
    expect(
      landingWorkspace({ lastUsedWorkspaceId: "ws_b", items: [a, b] })?.slug,
    ).toBe("beta")
  })

  it("falls back to the first Workspace when last-used is gone", () => {
    const a = ws("ws_a", "alpha")
    expect(
      landingWorkspace({ lastUsedWorkspaceId: "ws_missing", items: [a] })?.slug,
    ).toBe("alpha")
  })
})

const server = setupServer()

describe("workspace query HTTP helpers", () => {
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

  it("returns pending after a successful retry", async () => {
    server.use(
      http.post(
        "http://localhost:3000/:orgSlug/api/v1/workspaces/:workspaceSlug/retry-prepare",
        () =>
          HttpResponse.json({
            ...failedHydrateWorkspace,
            hydrateStatus: "pending",
            hydrateError: null,
          }),
      ),
    )
    const result = await retryPrepareWorkspace("acme", "knowledge-failed")
    expect(result.hydrateStatus).toBe("pending")
    expect(result.hydrateError).toBeNull()
  })

  it("surfaces evlog { message } when { error } is absent", async () => {
    server.use(
      http.delete(
        "http://localhost:3000/:orgSlug/api/v1/workspaces/:workspaceSlug",
        () =>
          HttpResponse.json(
            { message: "Connection terminated unexpectedly" },
            { status: 500 },
          ),
      ),
    )
    await expect(deleteWorkspace("acme", "docs", "Docs")).rejects.toThrow(
      "Connection terminated unexpectedly",
    )
  })

  it("prefers { error } over { message } for delete failures", async () => {
    server.use(
      http.delete(
        "http://localhost:3000/:orgSlug/api/v1/workspaces/:workspaceSlug",
        () =>
          HttpResponse.json(
            {
              error: "Type the Workspace display name to confirm delete",
              message: "Bad Request",
            },
            { status: 400 },
          ),
      ),
    )
    await expect(deleteWorkspace("acme", "docs", "wrong")).rejects.toThrow(
      "Type the Workspace display name to confirm delete",
    )
  })

  it("returns an empty tree when files/tree is not ready to browse", async () => {
    let hits = 0
    server.use(
      http.get(
        "http://localhost:3000/:orgSlug/api/v1/workspaces/:workspaceSlug/files/tree",
        () => {
          hits += 1
          return HttpResponse.json(
            { error: "This Workspace has no git SHA to browse yet." },
            { status: 409 },
          )
        },
      ),
    )
    await expect(fetchWorkspaceGitTree("acme", "knowledge")).resolves.toEqual({
      sha: "",
      paths: [],
    })
    expect(hits).toBe(1)
  })

  it("uses the shared query retry policy for files/tree", () => {
    expect(
      workspaceGitTreeOptions("acme", "knowledge", "").retry,
    ).toBeUndefined()
  })

  it("persists a successful conversation sandbox tree snapshot", async () => {
    clearAllConversationGitTreeSnapshots()
    server.use(
      http.get(
        "http://localhost:3000/:orgSlug/api/v1/conversations/:conversationId/files/tree",
        () =>
          HttpResponse.json({
            sha: "sandboxsha",
            paths: ["e2e-live-note.md"],
            branch: "ctxpipe/chat/conv_1/1",
          }),
      ),
    )
    const options = conversationGitTreeOptions("acme", "conv_1")
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const tree = await queryClient.fetchQuery(options)
    expect(tree.paths).toEqual(["e2e-live-note.md"])
    expect(readConversationGitTreeSnapshot("conv_1")).toEqual(tree)
    const placeholder = options.placeholderData
    expect(typeof placeholder).toBe("function")
    if (typeof placeholder === "function") {
      expect(placeholder(undefined, undefined)).toEqual(tree)
    }
    clearAllConversationGitTreeSnapshots()
  })

  it("sends attach=0 while the chat run is live and a snapshot exists", async () => {
    clearAllConversationGitTreeSnapshots()
    writeConversationGitTreeSnapshot("conv_1", {
      sha: "cachedsha",
      paths: ["AGENTS.md"],
      branch: "ctxpipe/chat/conv_1/1",
    })
    const seenAttach: Array<string | null> = []
    server.use(
      http.get(
        "http://localhost:3000/:orgSlug/api/v1/conversations/:conversationId/files/tree",
        ({ request }) => {
          seenAttach.push(new URL(request.url).searchParams.get("attach"))
          return HttpResponse.json({
            sha: "livesha",
            paths: ["AGENTS.md", "e2e.md"],
            branch: "ctxpipe/chat/conv_1/1",
          })
        },
      ),
    )
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(workspaceKeys.conversationChatLive("acme", "conv_1"), true)
    const tree = await queryClient.fetchQuery(
      conversationGitTreeOptions("acme", "conv_1"),
    )
    expect(seenAttach).toEqual(["0"])
    expect(tree.paths).toEqual(["AGENTS.md", "e2e.md"])
    clearAllConversationGitTreeSnapshots()
  })

  it("keeps the optimistic tree when a live list-only GET returns 409", async () => {
    clearAllConversationGitTreeSnapshots()
    const optimistic = {
      sha: "HEAD",
      paths: ["AGENTS.md", "e2e.md"],
      branch: "ctxpipe/chat/conv_1/1",
    }
    writeConversationGitTreeSnapshot("conv_1", optimistic)
    server.use(
      http.get(
        "http://localhost:3000/:orgSlug/api/v1/conversations/:conversationId/files/tree",
        () =>
          HttpResponse.json({ error: "missing_sandbox" }, { status: 409 }),
      ),
    )
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(
      workspaceKeys.conversationChatLive("acme", "conv_1"),
      true,
    )
    queryClient.setQueryData(
      workspaceKeys.conversationGitTree("acme", "conv_1"),
      optimistic,
    )
    const tree = await queryClient.fetchQuery(
      conversationGitTreeOptions("acme", "conv_1"),
    )
    expect(tree.paths).toEqual(["AGENTS.md", "e2e.md"])
    clearAllConversationGitTreeSnapshots()
  })

  it("attaches on the first tree load when there is no snapshot", async () => {
    clearAllConversationGitTreeSnapshots()
    const seenAttach: Array<string | null> = []
    server.use(
      http.get(
        "http://localhost:3000/:orgSlug/api/v1/conversations/:conversationId/files/tree",
        ({ request }) => {
          seenAttach.push(new URL(request.url).searchParams.get("attach"))
          return HttpResponse.json({
            sha: "livesha",
            paths: ["AGENTS.md"],
            branch: "ctxpipe/chat/conv_1/1",
          })
        },
      ),
    )
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(
      workspaceKeys.conversationChatLive("acme", "conv_1"),
      true,
    )
    await queryClient.fetchQuery(conversationGitTreeOptions("acme", "conv_1"))
    expect(seenAttach).toEqual([null])
    clearAllConversationGitTreeSnapshots()
  })
})
