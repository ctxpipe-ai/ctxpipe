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
import {
  beginGithubPopupFlow,
  GITHUB_SETUP_RESULT_KEY,
  getActiveGithubPopupFlowState,
  githubLinkErrorMessage,
  githubLinkPopupUrl,
  handleGithubSetupPopupResult,
  isGithubAppInstallUrl,
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

  it("ends the popup flow before it sends the window to /.github/setup", async () => {
    const nonce = beginGithubPopupFlow()
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({ installationId: 42, popupFlowNonce: nonce }),
    )
    refuseRegistration("github_not_linked")
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

  it("reports the link error that the popup of this flow relays, and registers nothing", async () => {
    const nonce = beginGithubPopupFlow()
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({
        linkError: "account_already_linked_to_different_user",
        popupFlowNonce: nonce,
      }),
    )
    // No registration handler: an unexpected request fails the test.

    const result = await handleGithubSetupPopupResult("acme", new QueryClient())

    expect(result).toEqual({
      status: "link_failed",
      linkError: "account_already_linked_to_different_user",
    })
  })

  it("ignores a link error from another flow", async () => {
    beginGithubPopupFlow()
    localStorage.setItem(
      GITHUB_SETUP_RESULT_KEY,
      JSON.stringify({
        linkError: "account_already_linked_to_different_user",
        popupFlowNonce: "another-flow",
      }),
    )
    server.use(
      http.get("*/acme/api/v1/github/installation", () =>
        HttpResponse.json(null),
      ),
    )

    const result = await handleGithubSetupPopupResult("acme", new QueryClient())

    expect(result).toEqual({ status: "no_result" })
  })
})

describe("the GitHub link popup", () => {
  it("goes on only to a GitHub App install page on github.com", () => {
    for (const url of [
      "https://github.com/apps/ctxpipe/installations/new?state=abc",
      "https://github.com/apps/ctxpipe/installations/select_target?state=abc",
    ]) {
      expect(isGithubAppInstallUrl(url)).toBe(true)
    }
    for (const url of [
      "https://github.com/login/oauth/authorize?client_id=other",
      "https://github.com/apps/ctxpipe",
      "https://github.com.evil.test/apps/x/installations/new",
      "https://github.com@evil.test/apps/x/installations/new",
      "https://evil.test/https://github.com/apps/x/installations/new",
      "http://github.com/apps/x/installations/new",
      "//github.com/apps/x/installations/new",
      "javascript:alert(1)",
      "/acme/connectors",
      "",
    ]) {
      expect(isGithubAppInstallUrl(url)).toBe(false)
    }
  })

  it("carries the install address to the link page", () => {
    const install = "https://github.com/apps/ctxpipe/installations/new?state=n1"
    const url = new URL(githubLinkPopupUrl(install), "http://app.test")
    expect(url.pathname).toBe("/.github/link")
    expect(url.searchParams.get("next")).toBe(install)
  })

  it("names GitHub, not another provider, when the account belongs to another user", () => {
    const message = githubLinkErrorMessage(
      "account_already_linked_to_different_user",
    )
    expect(message).toMatch(/GitHub account/)
    expect(message).not.toMatch(/Atlassian/)
  })
})
