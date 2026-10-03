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

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})

beforeEach(() => {
  // Browser globals the opener page has: storage, and an origin for the
  // API client's relative URLs.
  const store = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  })
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
})

afterAll(() => {
  server.close()
})

describe("handleGithubSetupPopupResult", () => {
  it("sends a user without a linked GitHub account through linking, then back to setup", async () => {
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({ installationId: 42, connectionId: "con_draft" }),
    )
    let linkSocialBody: unknown
    server.use(
      http.post("*/acme/api/v1/github/installation", () =>
        HttpResponse.json(
          { error: "Connect GitHub", why: "github_not_linked" },
          { status: 403 },
        ),
      ),
      http.post("*/.auth/api/v1/auth/link-social", async ({ request }) => {
        linkSocialBody = await request.json()
        return HttpResponse.json({ url: "#linked", redirect: true })
      }),
    )

    const { status } = await handleGithubSetupPopupResult(
      "acme",
      new QueryClient(),
    )

    expect(status).toBe("linking_github")
    expect(linkSocialBody).toMatchObject({
      provider: "github",
      callbackURL:
        "/.github/setup?installation_id=42&orgSlug=acme&connectionId=con_draft",
    })
  })

  it("reports a failed registration for any other refusal", async () => {
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({ installationId: 42 }),
    )
    server.use(
      http.post("*/acme/api/v1/github/installation", () =>
        HttpResponse.json(
          { error: "Forbidden", why: "github_installation_not_accessible" },
          { status: 403 },
        ),
      ),
    )

    const { status } = await handleGithubSetupPopupResult(
      "acme",
      new QueryClient(),
    )

    expect(status).toBe("registration_failed")
  })
})
