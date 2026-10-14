import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { installRelativeFetch } from "../workspaces/relative-fetch-test"
import {
  type ConnectionUsageResponse,
  connectionUsageOptions,
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

const pending = {
  sourceKey: "linear-2",
  provider: "linear" as const,
  action: "add" as const,
  pullRequestUrl: "https://github.com/acme/context/pull/40",
  createdAt: "2026-10-14T05:31:11Z",
}

/** "Used in" for one read: the open pull request, nothing, or the source. */
function usage(
  state: "pending" | "merged" | "projected",
): ConnectionUsageResponse {
  if (state === "merged") return { items: [] }
  return {
    items: [
      {
        workspaceId: "ws_context",
        workspaceSlug: "context",
        workspaceName: "context",
        stat: state === "projected" ? "1 Linear team" : "",
        sources:
          state === "projected"
            ? [
                {
                  sourceKey: "linear-2",
                  provider: "linear",
                  status: "ok",
                  scopeSummary: "1 Linear team",
                },
              ]
            : [],
        pendingChanges: state === "pending" ? [pending] : [],
      },
    ],
  }
}

/** The Sources list for one read: only the open pull request matters here. */
function sources(
  state: "pending" | "merged" | "projected",
): WorkspaceSourceListResponse {
  return {
    path: ".ctxpipe/sources.yaml",
    revision: null,
    fileError: null,
    items: [],
    canEdit: true,
    directCommitAllowed: true,
    pendingChanges: state === "pending" ? [pending] : [],
  }
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

  /**
   * Observes one query. `state(hit)` says what the server answers for each
   * read: a merge closes the pull request before the Workspace records the
   * source.
   */
  async function observe(
    options:
      | ReturnType<typeof connectionUsageOptions>
      | ReturnType<typeof workspaceSourcesOptions>,
    path: string,
    body: (
      state: "pending" | "merged" | "projected",
    ) => ConnectionUsageResponse | WorkspaceSourceListResponse,
    state: (hit: number) => "pending" | "merged" | "projected",
    run: (probe: {
      hits: () => number
      refetch: () => Promise<unknown>
    }) => Promise<void>,
  ) {
    let hits = 0
    server.use(
      http.get(`http://localhost:3000${path}`, () => {
        hits += 1
        return HttpResponse.json(body(state(hits)))
      }),
    )
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const observer = new QueryObserver(
      queryClient,
      options as ReturnType<typeof connectionUsageOptions>,
    )
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
  const afterMerge = (hit: number) =>
    hit === 1 ? "pending" : hit === 2 ? "merged" : "projected"

  it("polls Used in until the merged source shows, then stops", async () => {
    await observe(
      connectionUsageOptions("acme", "con_linear"),
      "/acme/api/v1/connectors/con_linear/workspaces",
      usage,
      afterMerge,
      async ({ hits, refetch }) => {
        await refetch()
        expect(hits()).toBe(2)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(hits()).toBe(3)

        await vi.advanceTimersByTimeAsync(10 * 60_000)
        const capped = hits()
        expect(capped).toBeLessThanOrEqual(26)
        await vi.advanceTimersByTimeAsync(10 * 60_000)
        expect(hits()).toBe(capped)
      },
    )
  })

  it("polls the Sources list after a merge too", async () => {
    await observe(
      workspaceSourcesOptions("acme", "context"),
      "/acme/api/v1/workspaces/context/sources",
      sources,
      afterMerge,
      async ({ hits, refetch }) => {
        await refetch()
        await vi.advanceTimersByTimeAsync(5_000)
        expect(hits()).toBe(3)
      },
    )
  })

  it("does not poll a list that had no open pull request", async () => {
    await observe(
      connectionUsageOptions("acme", "con_linear"),
      "/acme/api/v1/connectors/con_linear/workspaces",
      usage,
      () => "merged",
      async ({ hits, refetch }) => {
        await refetch()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(hits()).toBe(2)
      },
    )
  })
})
