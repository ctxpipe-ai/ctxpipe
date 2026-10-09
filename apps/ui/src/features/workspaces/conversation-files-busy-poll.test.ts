import { QueryClient, QueryObserver } from "@tanstack/react-query"
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
import { clearAllConversationGitTreeSnapshots } from "./conversation-git-tree-snapshot"
import {
  conversationGitStatusOptions,
  conversationGitTreeOptions,
} from "./queries"
import { installRelativeFetch } from "./relative-fetch-test"
import { installMemorySessionStorage } from "./session-storage-test"

// TanStack Query starts a refetchInterval timer only when `window` exists. It
// reads `window` once at import, so set it before the imports run.
vi.hoisted(() => {
  Object.assign(globalThis, { window: globalThis })
})

const server = setupServer()
let restoreFetch = () => {}

describe("conversation Files queries while a turn runs", () => {
  beforeAll(() => {
    installMemorySessionStorage()
    server.listen({ onUnhandledRequest: "error" })
    restoreFetch = installRelativeFetch()
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
    restoreFetch()
  })

  for (const route of ["tree", "status"] as const) {
    it(`asks files/${route} again after a 409 until a real answer arrives`, async () => {
      clearAllConversationGitTreeSnapshots()
      let hits = 0
      server.use(
        http.get(
          `http://localhost:3000/:orgSlug/api/v1/conversations/:conversationId/files/${route}`,
          () => {
            hits += 1
            // A turn holds the conversation: the first read is busy.
            if (hits === 1) {
              return HttpResponse.json(
                { error: "turn_running" },
                { status: 409 },
              )
            }
            return HttpResponse.json(
              route === "tree"
                ? {
                    sha: "livesha",
                    paths: ["AGENTS.md"],
                    branch: "ctxpipe/chat/conv_1/1",
                  }
                : {
                    branch: "ctxpipe/chat/conv_1/1",
                    source: "sandbox",
                    dirty: true,
                    differsFromDefault: true,
                    unpushed: true,
                    published: false,
                    ahead: 1,
                    behind: 0,
                    items: [{ path: "AGENTS.md", status: "modified" }],
                  },
            )
          },
        ),
      )
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      const tree = new QueryObserver(
        queryClient,
        conversationGitTreeOptions("acme", "conv_1"),
      )
      const status = new QueryObserver(
        queryClient,
        conversationGitStatusOptions("acme", "conv_1"),
      )
      const unsubscribe =
        route === "tree" ? tree.subscribe(() => {}) : status.subscribe(() => {})
      try {
        await vi.waitFor(
          () => {
            const paths =
              route === "tree"
                ? tree.getCurrentResult().data?.paths
                : status.getCurrentResult().data?.items.map((item) => item.path)
            expect(paths).toEqual(["AGENTS.md"])
          },
          { timeout: 5_000, interval: 100 },
        )
        expect(hits).toBe(2)
      } finally {
        unsubscribe()
        queryClient.clear()
        clearAllConversationGitTreeSnapshots()
      }
    }, 10_000)

    it(`does not ask files/${route} again after a 409 missing_sandbox`, async () => {
      clearAllConversationGitTreeSnapshots()
      let hits = 0
      server.use(
        http.get(
          `http://localhost:3000/:orgSlug/api/v1/conversations/:conversationId/files/${route}`,
          () => {
            hits += 1
            // An idle-stopped sandbox: no turn will end this 409.
            return HttpResponse.json(
              { error: "missing_sandbox" },
              { status: 409 },
            )
          },
        ),
      )
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      const observer =
        route === "tree"
          ? new QueryObserver(
              queryClient,
              conversationGitTreeOptions("acme", "conv_1"),
            )
          : new QueryObserver(
              queryClient,
              conversationGitStatusOptions("acme", "conv_1"),
            )
      const unsubscribe = observer.subscribe(() => {})
      try {
        await vi.waitFor(() => expect(hits).toBe(1), {
          timeout: 2_000,
          interval: 50,
        })
        // Wait past one poll interval (2 s).
        await new Promise((resolve) => setTimeout(resolve, 2_500))
        expect(hits).toBe(1)
      } finally {
        unsubscribe()
        queryClient.clear()
        clearAllConversationGitTreeSnapshots()
      }
    }, 10_000)
  }
})
