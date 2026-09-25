// @vitest-environment jsdom

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { init, addAction, setGlobalAttributes } = vi.hoisted(() => ({
  init: vi.fn(),
  addAction: vi.fn(),
  setGlobalAttributes: vi.fn(),
}))

vi.mock("@hyperdx/browser", () => ({
  default: {
    init,
    addAction,
    setGlobalAttributes,
    recordException: vi.fn(),
  },
}))

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: {
      user: { id: "user_1" },
      session: { activeOrganizationId: "org_1" },
    },
    isPending: false,
  }),
  useListOrganizations: () => ({
    data: [{ id: "org_1", slug: "obs-e2e-343" }],
    isPending: false,
  }),
}))

import { HyperDxProvider } from "./HyperDxProvider"

describe("HyperDxProvider client navigations", () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    container?.remove()
    addAction.mockClear()
    setGlobalAttributes.mockClear()
  })

  it("records one page_view per client navigation with the org slug and route id", async () => {
    const rootRoute = createRootRoute({
      shellComponent: ({ children }) => (
        <HyperDxProvider
          runtimeConfig={{
            enabled: true,
            url: "/.otel",
            environment: "test",
          }}
        >
          {children}
        </HyperDxProvider>
      ),
      component: () => <Outlet />,
    })
    const signInRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/.auth/sign-in",
      component: () => <p>Sign in</p>,
    })
    const orgRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/$orgSlug",
      component: () => <Outlet />,
    })
    const indexRoute = createRoute({
      getParentRoute: () => orgRoute,
      path: "/",
      component: () => <p>Home</p>,
    })
    const chatRoute = createRoute({
      getParentRoute: () => orgRoute,
      path: "chat",
      component: () => <p>Chat</p>,
    })
    const repositoriesRoute = createRoute({
      getParentRoute: () => orgRoute,
      path: "repositories",
      component: () => <p>Repositories</p>,
    })
    const routeTree = rootRoute.addChildren([
      signInRoute,
      orgRoute.addChildren([indexRoute, chatRoute, repositoriesRoute]),
    ])
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({
        initialEntries: ["/.auth/sign-in"],
      }),
    })

    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<RouterProvider router={router} />)
    })

    const pageViews = () =>
      addAction.mock.calls.filter((call) => call[0] === "page_view")

    expect(pageViews().map((call) => call[1])).toEqual([
      {
        path: "/.auth/sign-in",
        route: "/.auth/sign-in",
        "ctxpipe.org.slug": "",
      },
    ])

    await act(async () => {
      await router.navigate({ href: "/obs-e2e-343" })
    })
    await act(async () => {
      await router.navigate({ href: "/obs-e2e-343/chat" })
    })
    await act(async () => {
      await router.navigate({ href: "/obs-e2e-343/repositories" })
    })

    expect(pageViews().map((call) => call[1])).toEqual([
      {
        path: "/.auth/sign-in",
        route: "/.auth/sign-in",
        "ctxpipe.org.slug": "",
      },
      {
        path: "/obs-e2e-343",
        route: "/$orgSlug/",
        "ctxpipe.org.slug": "obs-e2e-343",
      },
      {
        path: "/obs-e2e-343/chat",
        route: "/$orgSlug/chat",
        "ctxpipe.org.slug": "obs-e2e-343",
      },
      {
        path: "/obs-e2e-343/repositories",
        route: "/$orgSlug/repositories",
        "ctxpipe.org.slug": "obs-e2e-343",
      },
    ])

    expect(setGlobalAttributes).toHaveBeenCalledWith({
      userId: "user_1",
      teamId: "org_1",
      teamName: "obs-e2e-343",
    })
  })
})
