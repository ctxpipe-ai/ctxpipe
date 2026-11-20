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

import { ApiError } from "./api-result"
import {
  beginGithubPopupFlow,
  GITHUB_SETUP_RESULT_KEY,
  getActiveGithubPopupFlowState,
  githubAuthorizeUrlOf,
  handleGithubSetupPopupResult,
} from "./popup"

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
  serveAuthConfig("https://github.com/login/oauth/authorize")
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

/** The deployment's `/.auth/api/config`, with its GitHub authorize page. */
function serveAuthConfig(githubAuthorizeUrl: string) {
  server.use(
    http.get("*/.auth/api/config", () =>
      HttpResponse.json({ providers: ["github"], githubAuthorizeUrl }),
    ),
  )
}

function refuseRegistration(why: string, authorizeUrl?: string) {
  server.use(
    http.post("*/acme/api/v1/github/installation", () =>
      HttpResponse.json(
        { error: "Refused", why, ...(authorizeUrl ? { authorizeUrl } : {}) },
        { status: 403 },
      ),
    ),
  )
}

const authorizeUrl =
  "https://github.com/login/oauth/authorize?client_id=Iv1.test&state=s1"

describe("handleGithubSetupPopupResult", () => {
  it("sends the user to GitHub to authorize the App once", async () => {
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({ installationId: 42 }),
    )
    refuseRegistration("github_authorization_required", authorizeUrl)

    const { status } = await handleGithubSetupPopupResult(
      "acme",
      new QueryClient(),
    )

    expect(status).toBe("redirected")
    expect(assign).toHaveBeenCalledWith(authorizeUrl)
  })

  it("sends the user to the deployment's own authorize page, behind an OAuth forwarder", async () => {
    const forwarded =
      "https://forwarder.example.test/github/authorize/pr-12?client_id=Iv1.test&state=s1"
    serveAuthConfig("https://forwarder.example.test/github/authorize/pr-12")
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({ installationId: 42 }),
    )
    refuseRegistration("github_authorization_required", forwarded)

    const { status } = await handleGithubSetupPopupResult(
      "acme",
      new QueryClient(),
    )

    expect(status).toBe("redirected")
    expect(assign).toHaveBeenCalledWith(forwarded)
  })

  it("goes nowhere when the refusal names another page than the deployment's", async () => {
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({ installationId: 42 }),
    )
    refuseRegistration(
      "github_authorization_required",
      "https://forwarder.example.test/github/authorize/pr-12?state=s1",
    )

    const { status } = await handleGithubSetupPopupResult(
      "acme",
      new QueryClient(),
    )

    expect(status).toBe("registration_failed")
    expect(assign).not.toHaveBeenCalled()
  })

  it("sends the user to /.github/setup when the deployment cannot ask GitHub", async () => {
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({ installationId: 42, connectionId: "con_draft" }),
    )
    refuseRegistration("github_authorization_unavailable")

    const { status } = await handleGithubSetupPopupResult(
      "acme",
      new QueryClient(),
    )

    expect(status).toBe("redirected")
    expect(assign).toHaveBeenCalledWith(
      "/.github/setup?installation_id=42&orgSlug=acme&connectionId=con_draft",
    )
  })

  it("ends the popup flow before it leaves the page", async () => {
    const nonce = beginGithubPopupFlow()
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({ installationId: 42, popupFlowNonce: nonce }),
    )
    refuseRegistration("github_authorization_required", authorizeUrl)
    // The browser unloads the opener on navigation, so no later code runs.
    let flowAtNavigation: unknown = "not navigated"
    assign.mockImplementation(() => {
      flowAtNavigation = getActiveGithubPopupFlowState()
    })

    await handleGithubSetupPopupResult("acme", new QueryClient())

    // A live flow makes /.github/setup act as the popup: it calls
    // window.close(), which a full page ignores, and stays blank.
    expect(flowAtNavigation).toBeNull()
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

describe("githubAuthorizeUrlOf", () => {
  const refusal = (authorizeUrl: string | undefined) =>
    new ApiError("Refused", 403, {
      body: { why: "github_authorization_required", authorizeUrl },
    })

  it("accepts only GitHub's authorize page", () => {
    expect(githubAuthorizeUrlOf(refusal(authorizeUrl))).toBe(authorizeUrl)
    for (const url of [
      "https://github.com/apps/ctxpipe/installations/new",
      "https://github.com.evil.test/login/oauth/authorize",
      "https://github.com@evil.test/login/oauth/authorize",
      "http://github.com/login/oauth/authorize",
      "//github.com/login/oauth/authorize",
      "javascript:alert(1)",
      "/acme/connectors",
      "",
      undefined,
    ]) {
      expect(githubAuthorizeUrlOf(refusal(url))).toBeNull()
    }
  })

  it("accepts only the deployment's authorize page when it has an OAuth forwarder", () => {
    const page = "https://forwarder.example.test/github/authorize/pr-12"
    expect(githubAuthorizeUrlOf(refusal(`${page}?state=s1`), page)).toBe(
      `${page}?state=s1`,
    )
    for (const url of [
      authorizeUrl,
      "https://forwarder.example.test/github/authorize/pr-13?state=s1",
      "http://forwarder.example.test/github/authorize/pr-12?state=s1",
      "https://forwarder.example.test.evil.test/github/authorize/pr-12",
    ]) {
      expect(githubAuthorizeUrlOf(refusal(url), page)).toBeNull()
    }
  })

  it("ignores any other refusal", () => {
    const other = new ApiError("Refused", 403, {
      body: { why: "github_installation_not_accessible", authorizeUrl },
    })
    expect(githubAuthorizeUrlOf(other)).toBeNull()
    expect(githubAuthorizeUrlOf(new Error("network"))).toBeNull()
  })
})
