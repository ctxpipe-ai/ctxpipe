import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { installRelativeFetch } from "../workspaces/relative-fetch-test"
import {
  type ConnectionUsageResponse,
  connectionUsageOptions,
  type PendingSourceChange,
  type WorkspaceSourceListResponse,
  workspaceSourcesOptions,
} from "./queries"

// TanStack Query starts a refetchInterval timer only when `window` exists. It
// reads `window` once at import, so set it before the imports run.
vi.hoisted(() => {
  Object.assign(globalThis, { window: globalThis })
})

const server = setupServer()
let restoreFetch = () => {}

/**
 * What the server answers for one read: the pull requests still open, or
 * after the merge, nothing until the Workspace records the source.
 */
type ReadState = { open: number[] } | "merged" | "projected"

const pull = (number: number): PendingSourceChange => ({
  sourceKey: `linear-${number}`,
  provider: "linear",
  action: "add",
  pullRequestUrl: `https://github.com/acme/context/pull/${number}`,
  createdAt: "2026-10-14T05:31:11Z",
})

function usage(state: ReadState): ConnectionUsageResponse {
  if (state === "merged") return { items: [] }
  const projected = state === "projected"
  return {
    items: [
      {
        workspaceId: "ws_context",
        workspaceSlug: "context",
        workspaceName: "context",
        stat: projected ? "1 Linear team" : "",
        sources: projected
          ? [
              {
                sourceKey: "linear-40",
                provider: "linear",
                status: "ok",
                scopeSummary: "1 Linear team",
              },
            ]
          : [],
        pendingChanges: projected ? [] : state.open.map(pull),
      },
    ],
  }
}

function sources(state: ReadState): WorkspaceSourceListResponse {
  return {
    path: ".ctxpipe/sources.yaml",
    revision: null,
    fileError: null,
    items: [],
    canEdit: true,
    pendingChanges: typeof state === "object" ? state.open.map(pull) : [],
  }
}

/** One list query and the route that answers it. */
type ListQuery = {
  observer: (
    queryClient: QueryClient,
  ) => Pick<QueryObserver, "subscribe" | "refetch">
  path: string
  body: (state: ReadState) => object
}

const usedIn: ListQuery = {
  observer: (queryClient) =>
    new QueryObserver(
      queryClient,
      connectionUsageOptions("acme", "con_linear"),
    ),
  path: "/acme/api/v1/connectors/con_linear/workspaces",
  body: usage,
}

describe("refresh after a source pull request merges", () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" })
    restoreFetch = installRelativeFetch()
  })
  afterAll(() => {
    server.close()
    restoreFetch()
  })

  /** Observes one list query. `state(hit)` is the server answer per read. */
  async function observe(
    list: ListQuery,
    state: (hit: number) => ReadState,
    run: (probe: {
      hits: () => number
      refetch: () => Promise<unknown>
    }) => Promise<void>,
  ) {
    let hits = 0
    server.use(
      http.get(`http://localhost:3000${list.path}`, () => {
        hits += 1
        return HttpResponse.json(list.body(state(hits)))
      }),
    )
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const observer = list.observer(queryClient)
    const unsubscribe = observer.subscribe(() => {})
    try {
      await vi.waitFor(() => expect(hits).toBe(1))
      await run({ hits: () => hits, refetch: () => observer.refetch() })
    } finally {
      unsubscribe()
      queryClient.clear()
      vi.useRealTimers()
    }
  }

  // Read 1: the pull request is open. Read 2 (the user comes back after the
  // merge): neither the pull request nor the source. Read 3 on: the source.
  const afterMerge = (hit: number): ReadState =>
    hit === 1 ? { open: [40] } : hit === 2 ? "merged" : "projected"

  it("polls Used in until the merged source shows, then stops", async () => {
    await observe(usedIn, afterMerge, async ({ hits, refetch }) => {
      await refetch()
      expect(hits()).toBe(2)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(hits()).toBe(3)

      // The window is 2 minutes: 5 s reads for 115 s more, then it stops.
      await vi.advanceTimersByTimeAsync(115_000)
      expect(hits()).toBeGreaterThan(20)
      await vi.advanceTimersByTimeAsync(10_000)
      const capped = hits()
      expect(capped).toBeLessThanOrEqual(27)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(hits()).toBe(capped)
    })
  })

  it("polls the Sources list after a merge too", async () => {
    const sourcesList: ListQuery = {
      observer: (queryClient) =>
        new QueryObserver(
          queryClient,
          workspaceSourcesOptions("acme", "context"),
        ),
      path: "/acme/api/v1/workspaces/context/sources",
      body: sources,
    }
    await observe(sourcesList, afterMerge, async ({ hits, refetch }) => {
      await refetch()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(hits()).toBe(3)
    })
  })

  it("polls when one of two open pull requests merges", async () => {
    await observe(
      usedIn,
      (hit) => (hit === 1 ? { open: [40, 41] } : { open: [41] }),
      async ({ hits, refetch }) => {
        await refetch()
        await vi.advanceTimersByTimeAsync(5_000)
        expect(hits()).toBe(3)
      },
    )
  })

  it("does not poll a list that had no open pull request", async () => {
    await observe(
      usedIn,
      () => "merged",
      async ({ hits, refetch }) => {
        await refetch()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(hits()).toBe(2)
      },
    )
  })
})
