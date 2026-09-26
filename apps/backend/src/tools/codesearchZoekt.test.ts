import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../test/msw.js"
import {
  isZoektSearchClientFailure,
  zoektSearchRepository,
} from "./codesearchZoekt.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

const repository = {
  id: "repo_1",
  orgId: "org_1",
  zoektRepoId: 7,
  name: "linguist",
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-with-at-least-32-characters")
  vi.stubEnv("CODESEARCH_URL", "http://codesearch.test")
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://ctxpipe:ctxpipe@127.0.0.1:5433/ctxpipe",
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("zoektSearchRepository", () => {
  it("reports a Zoekt query rejection as a client error", async () => {
    server.use(
      http.post("http://codesearch.test/search", () =>
        HttpResponse.json(
          {
            error: "Zoekt rejected the query: parse error: unexpected token",
            code: "query_rejected",
          },
          { status: 400 },
        ),
      ),
    )

    const result = await zoektSearchRepository(repository, "file:((", {})

    expect(isZoektSearchClientFailure(result)).toBe(true)
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Zoekt rejected the query: parse error: unexpected token",
    })
  })

  it("throws when codesearch is unavailable", async () => {
    server.use(
      http.post("http://codesearch.test/search", () =>
        HttpResponse.text("unavailable", { status: 500 }),
      ),
    )

    await expect(
      zoektSearchRepository(repository, "needle", {}),
    ).rejects.toThrow("codesearch search failed with status 500: unavailable")
  })
})
