// @vitest-environment jsdom

import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { LinkAtlassianStep } from "./LinkAtlassianStep"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// The deployment uses one Atlassian OAuth app, so the step links the account
// through Better Auth.
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      globalAtlassianOAuthConfigured: true,
      oauthAppSaved: false,
      atlassianOAuthClientId: null,
    },
    isPending: false,
    isError: false,
  }),
}))

// React Aria loads a second React copy under jsdom here; render a plain button.
vi.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    onPress,
  }: {
    children?: ReactNode
    onPress?: () => void
  }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}))

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
      http.post("*/.auth/api/v1/auth/link-social", async ({ request }) => {
        linkBody = (await request.json()) as typeof linkBody
        return HttpResponse.json({ url: "", redirect: false })
      }),
    )

    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    act(() =>
      root?.render(
        <LinkAtlassianStep orgSlug="acme" atlassianConnectionId="con_forge1" />,
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
