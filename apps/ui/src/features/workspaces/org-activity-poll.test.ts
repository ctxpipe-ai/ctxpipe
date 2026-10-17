import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { activityOptions } from "./queries"
import { installRelativeFetch } from "./relative-fetch-test"
import { docsWorkspaceActivity } from "./workspace-fixtures"

// TanStack Query starts a refetchInterval timer only when `window` exists. It
// reads `window` once at import, so set it before the imports run.
vi.hoisted(() => {
  Object.assign(globalThis, { window: globalThis })
})

const server = setupServer()
let restoreFetch = () => {}

describe("org activity poll while a workspace is pending (CTX-556)", () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" })
    restoreFetch = installRelativeFetch()
  })
  afterAll(() => {
    server.close()
    restoreFetch()
  })

  /** Observes one activity query. `pending(hit)` says if a read lists a pending workspace. */
  async function observe(
    date: string | null,
    pending: (hit: number) => boolean,
    run: (state: {
      hits: () => number
      refetch: () => Promise<unknown>
    }) => Promise<void>,
  ) {
    let hits = 0
    server.use(
      http.get("http://localhost:3000/:orgSlug/api/v1/activity", () => {
        hits += 1
        return HttpResponse.json({
          ...docsWorkspaceActivity,
          status: "ready",
          pendingWorkspaces: pending(hits)
            ? [{ slug: "handbook", name: "Handbook" }]
            : [],
        })
      }),
    )
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const observer = new QueryObserver(
      queryClient,
      activityOptions("acme", null, date),
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

  it("polls every 10 s and stops after about 3 minutes", async () => {
    await observe(
      null,
      () => true,
      async ({ hits }) => {
        await vi.advanceTimersByTimeAsync(9_000)
        expect(hits()).toBe(1)
        await vi.advanceTimersByTimeAsync(2_000)
        expect(hits()).toBe(2)

        await vi.advanceTimersByTimeAsync(10 * 60_000)
        const capped = hits()
        expect(capped).toBeLessThanOrEqual(20)
        await vi.advanceTimersByTimeAsync(10 * 60_000)
        expect(hits()).toBe(capped)
      },
    )
  })

  it("polls a workspace that becomes pending after many reads", async () => {
    await observe(
      null,
      (hit) => hit > 20,
      async ({ hits, refetch }) => {
        for (let read = 0; read < 20; read += 1) await refetch()
        expect(hits()).toBe(21)
        await vi.advanceTimersByTimeAsync(11_000)
        expect(hits()).toBe(22)
      },
    )
  })

  it("does not poll the read of one day", async () => {
    await observe(
      "2026-08-22",
      () => true,
      async ({ hits }) => {
        await vi.advanceTimersByTimeAsync(60_000)
        expect(hits()).toBe(1)
      },
    )
  })
})
