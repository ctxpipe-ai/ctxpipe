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
import { GITHUB_SETUP_RESULT_KEY, handleGithubSetupPopupResult } from "./popup"

const server = setupServer()
const assign = vi.fn()

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})

beforeEach(() => {
  // Browser globals the opener page has: storage, navigation, and an origin
  // for the API client's relative URLs.
  const store = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  })
  vi.stubGlobal("window", { location: { assign } })
  const fetchWithOrigin = globalThis.fetch
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithOrigin(
      typeof input === "string" ? new URL(input, "http://app.test") : input,
      init,
    ),
  )
})

afterEach(() => {
  server.resetHandlers()
  vi.unstubAllGlobals()
  assign.mockReset()
})

afterAll(() => {
  server.close()
})

function refuseRegistration(why: string) {
  server.use(
    http.post("*/acme/api/v1/github/installation", () =>
      HttpResponse.json({ error: "Refused", why }, { status: 403 }),
    ),
  )
}

describe("handleGithubSetupPopupResult", () => {
  it("sends a user without a linked GitHub account to /.github/setup to link it", async () => {
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({ installationId: 42, connectionId: "con_draft" }),
    )
    refuseRegistration("github_not_linked")

    const { status } = await handleGithubSetupPopupResult(
      "acme",
      new QueryClient(),
    )

    expect(status).toBe("redirected")
    expect(assign).toHaveBeenCalledWith(
      "/.github/setup?installation_id=42&orgSlug=acme&connectionId=con_draft",
    )
  })

  it("reports a failed registration for any other refusal", async () => {
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({ installationId: 42 }),
    )
    refuseRegistration("github_installation_not_accessible")

    const { status } = await handleGithubSetupPopupResult(
      "acme",
      new QueryClient(),
    )

    expect(status).toBe("registration_failed")
    expect(assign).not.toHaveBeenCalled()
  })
})
