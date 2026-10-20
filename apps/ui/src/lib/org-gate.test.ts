import { QueryClient } from "@tanstack/react-query"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { API_FETCH_TIMEOUT_SSR_MS, ApiError, retryQuery } from "./api-result"
import {
  type OrgGate,
  orgGateKeys,
  orgGateOptions,
  peekOrgGate,
} from "./org-gate"

const memberGate: OrgGate = {
  session: {
    session: { id: "sess_1", userId: "user_1" },
    user: {
      id: "user_1",
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    },
  },
  organizations: [{ id: "org_1", name: "Acme", slug: "acme" }],
  orgAccessDenied: false,
}

describe("peekOrgGate", () => {
  it("returns cached gate for the org slug", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(orgGateOptions("acme").queryKey, memberGate)
    expect(peekOrgGate(queryClient, "acme")).toEqual(memberGate)
  })

  it("misses a different org slug", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(orgGateOptions("acme").queryKey, memberGate)
    expect(peekOrgGate(queryClient, "other")).toBeUndefined()
  })

  it("misses after the gate is invalidated", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(orgGateOptions("acme").queryKey, memberGate)
    await queryClient.invalidateQueries({ queryKey: orgGateKeys.all })
    expect(peekOrgGate(queryClient, "acme")).toBeUndefined()
  })
})

describe("orgGateOptions against the backend", () => {
  const backend = "http://backend.test"
  const session = {
    session: { id: "sess_1", userId: "user_1" },
    user: { id: "user_1", onboardingCompletedAt: "2026-01-01T00:00:00.000Z" },
  }
  const server = setupServer()

  beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
  beforeEach(() => vi.stubEnv("AUTH_BASE_URL", backend))
  afterEach(() => {
    server.resetHandlers()
    vi.unstubAllEnvs()
  })
  afterAll(() => server.close())

  function fetchGate() {
    return new QueryClient().fetchQuery({
      ...orgGateOptions("acme"),
      retry: false,
    })
  }

  it("resolves a signed-out gate when the backend says there is no session", async () => {
    server.use(
      http.get(`${backend}/.auth/api/v1/auth/get-session`, () =>
        HttpResponse.json(null),
      ),
      http.get(`${backend}/.auth/api/v1/auth/organization/list`, () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    )
    await expect(fetchGate()).resolves.toEqual({
      session: null,
      organizations: [],
      orgAccessDenied: true,
    })
  })

  it("rejects, and does not report signed out, when the session check cannot reach the backend", async () => {
    server.use(
      http.get(`${backend}/.auth/api/v1/auth/get-session`, () =>
        HttpResponse.error(),
      ),
      http.get(`${backend}/.auth/api/v1/auth/organization/list`, () =>
        HttpResponse.json([{ id: "org_1", name: "Acme", slug: "acme" }]),
      ),
    )
    await expect(fetchGate()).rejects.toBeInstanceOf(ApiError)
  })

  it("rejects, and does not report no organizations, when the organization list cannot reach the backend", async () => {
    server.use(
      http.get(`${backend}/.auth/api/v1/auth/get-session`, () =>
        HttpResponse.json(session),
      ),
      http.get(`${backend}/.auth/api/v1/auth/organization/list`, () =>
        HttpResponse.error(),
      ),
    )
    await expect(fetchGate()).rejects.toBeInstanceOf(ApiError)
  })

  it("rejects when the backend answers the session check with a server error", async () => {
    server.use(
      http.get(`${backend}/.auth/api/v1/auth/get-session`, () =>
        HttpResponse.json({ message: "Bad gateway" }, { status: 502 }),
      ),
      http.get(`${backend}/.auth/api/v1/auth/organization/list`, () =>
        HttpResponse.json([{ id: "org_1", name: "Acme", slug: "acme" }]),
      ),
    )
    await expect(fetchGate()).rejects.toMatchObject({
      status: 502,
      message: "Bad gateway",
    })
  })

  it("resolves a signed-out gate when the session check answers 401", async () => {
    server.use(
      http.get(`${backend}/.auth/api/v1/auth/get-session`, () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
      http.get(`${backend}/.auth/api/v1/auth/organization/list`, () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    )
    await expect(fetchGate()).resolves.toMatchObject({ session: null })
  })

  it("does not retry during the server render, so one stall stays under the backend proxy timeout", async () => {
    let sessionCalls = 0
    server.use(
      http.get(`${backend}/.auth/api/v1/auth/get-session`, () => {
        sessionCalls += 1
        return HttpResponse.error()
      }),
      http.get(`${backend}/.auth/api/v1/auth/organization/list`, () =>
        HttpResponse.json([{ id: "org_1", name: "Acme", slug: "acme" }]),
      ),
    )
    // The app QueryClient retries network errors once (retryQuery).
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: retryQuery, retryDelay: 0 } },
    })
    await expect(
      queryClient.fetchQuery(orgGateOptions("acme")),
    ).rejects.toBeInstanceOf(ApiError)
    expect(sessionCalls).toBe(1)
    // Worst case is one SSR timeout. UI_PROXY_TIMEOUT_MS in
    // apps/backend/src/routes/ui.ts is 15 s.
    expect(API_FETCH_TIMEOUT_SSR_MS).toBeLessThan(15_000)
  })
})
