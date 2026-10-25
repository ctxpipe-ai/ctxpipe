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

import { orgGateOptions } from "@/lib/org-gate"

import { completeOnboarding } from "./complete-onboarding"

const backend = "http://backend.test"
const server = setupServer()
let completedAt: string | null = null

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
beforeEach(() => {
  completedAt = null
  // The org gate reads the backend origin from the environment.
  vi.stubEnv("AUTH_BASE_URL", backend)
  // The API client sends relative URLs, as on the page.
  const fetchWithOrigin = globalThis.fetch
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithOrigin(
      typeof input === "string" ? new URL(input, backend) : input,
      init,
    ),
  )
  server.use(
    http.get("*/.auth/api/v1/auth/get-session", () =>
      HttpResponse.json({
        session: { id: "sess_1", userId: "user_1" },
        user: { id: "user_1", onboardingCompletedAt: completedAt },
      }),
    ),
    http.get("*/.auth/api/v1/auth/organization/list", () =>
      HttpResponse.json([{ id: "org_1", name: "Acme", slug: "acme" }]),
    ),
    http.get("*/.auth/api/v1/auth/organization/get-active-member-role", () =>
      HttpResponse.json({ role: "member" }),
    ),
    http.post("*/api/v1/onboarding/user/complete", () => {
      completedAt = "2026-10-16T00:00:00.000Z"
      return HttpResponse.json({ completedAt })
    }),
  )
})
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
afterAll(() => server.close())

describe("completeOnboarding", () => {
  it("drops the org gate cached before onboarding, so the org pages do not send the user back", async () => {
    const queryClient = new QueryClient()
    // A visit to the org page before onboarding cached its gate with
    // onboarding open; the org page then sent the user to /onboarding.
    const before = await queryClient.fetchQuery(orgGateOptions("acme"))
    expect(before.session?.user.onboardingCompletedAt).toBeNull()

    await completeOnboarding("acme", queryClient)

    // The org layout reads its gate like this.
    const after = await queryClient.ensureQueryData(orgGateOptions("acme"))
    expect(after.session?.user.onboardingCompletedAt).toBe(
      "2026-10-16T00:00:00.000Z",
    )
  })
})
