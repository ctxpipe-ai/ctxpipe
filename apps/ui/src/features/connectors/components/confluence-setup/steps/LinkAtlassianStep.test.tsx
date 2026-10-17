// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { LinkAtlassianStep } from "./LinkAtlassianStep"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const server = setupServer()
let root: Root | undefined
let container: HTMLDivElement | undefined

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  server.resetHandlers()
})

afterAll(() => {
  server.close()
})

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = read()
    if (value !== undefined) return value
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
  }
  throw new Error("waitFor timed out")
}

describe("LinkAtlassianStep", () => {
  it("returns to the connectors page with the wizard connection after the account link", async () => {
    window.history.replaceState(
      null,
      "",
      "/acme/connectors?pendingAccountClaim=x",
    )
    let linkBody: { provider?: string; callbackURL?: string } | undefined
    server.use(
      // The deployment uses one Atlassian OAuth app, so the step links the
      // account through Better Auth.
      http.get("*/acme/api/v1/org/atlassian-oauth", () =>
        HttpResponse.json({
          globalAtlassianOAuthConfigured: true,
          oauthAppSaved: false,
          atlassianOAuthClientId: null,
        }),
      ),
      http.post("*/.auth/api/v1/auth/link-social", async ({ request }) => {
        linkBody = (await request.json()) as typeof linkBody
        return HttpResponse.json({ url: "", redirect: false })
      }),
      // Better Auth reads the session again after the link call.
      http.get("*/.auth/api/v1/auth/get-session", () =>
        HttpResponse.json(null),
      ),
    )

    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    act(() =>
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <LinkAtlassianStep
            orgSlug="acme"
            atlassianConnectionId="con_forge1"
          />
        </QueryClientProvider>,
      ),
    )

    const button = await waitFor(() =>
      [...(container?.querySelectorAll("button") ?? [])].find(
        (element) => element.textContent === "Connect Atlassian account",
      ),
    )
    act(() => button.click())

    const body = await waitFor(() => linkBody)
    expect(body).toMatchObject({
      provider: "atlassian",
      callbackURL:
        "/acme/connectors?pendingAccountClaim=x&atlassianConnectionId=con_forge1",
    })
  })
})
