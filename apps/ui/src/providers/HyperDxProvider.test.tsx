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

const { init, addAction, setGlobalAttributes, orgState, sessionState } =
  vi.hoisted(() => ({
    init: vi.fn(),
    addAction: vi.fn(),
    setGlobalAttributes: vi.fn(),
    orgState: {
      data: [{ id: "org_1", slug: "obs-e2e-343" }] as
        | { id: string; slug: string }[]
        | undefined,
      isPending: false,
    },
    sessionState: {
      pending: false,
      userId: "user_1" as string | undefined,
      activeOrganizationId: "org_1",
    },
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
    data: sessionState.userId
      ? {
          user: { id: sessionState.userId },
          session: {
            activeOrganizationId: sessionState.activeOrganizationId,
          },
        }
      : null,
    isPending: sessionState.pending,
  }),
  useListOrganizations: () => orgState,
}))

import { setHyperDxGlobalAttributes } from "@/lib/hyperdxBrowser"
import {
  resetRetainedHyperDxRuntimeConfigForTests,
  retainServerHyperDxConfig,
} from "@/lib/hyperdxRuntimeConfig"
import {
  HyperDxPageView,
  HyperDxProvider,
  resetHyperDxProviderForTests,
} from "./HyperDxProvider"

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
    init.mockClear()
    sessionStorage.clear()
    localStorage.clear()
    resetRetainedHyperDxRuntimeConfigForTests()
    resetHyperDxProviderForTests()
    orgState.data = [{ id: "org_1", slug: "obs-e2e-343" }]
    orgState.isPending = false
    sessionState.pending = false
    sessionState.userId = "user_1"
    sessionState.activeOrganizationId = "org_1"
  })

  it("records one page_view per client navigation with the org slug and route id", async () => {
    const runtimeConfig = {
      enabled: true as const,
      environment: "test",
    }
    const rootRoute = createRootRoute({
      shellComponent: ({ children }) => (
        <HyperDxProvider runtimeConfig={runtimeConfig}>
          {children}
        </HyperDxProvider>
      ),
      component: () => (
        <>
          <HyperDxPageView runtimeConfig={runtimeConfig} />
          <Outlet />
        </>
      ),
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

    const identity = {
      userId: "user_1",
      teamId: "org_1",
      teamName: "obs-e2e-343",
    }
    expect(pageViews().map((call) => call[1])).toEqual([
      {
        path: "/.auth/sign-in",
        route: "/.auth/sign-in",
        "ctxpipe.org.slug": "",
        ...identity,
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
        ...identity,
      },
      {
        path: "/obs-e2e-343",
        route: "/$orgSlug/",
        "ctxpipe.org.slug": "obs-e2e-343",
        ...identity,
      },
      {
        path: "/obs-e2e-343/chat",
        route: "/$orgSlug/chat",
        "ctxpipe.org.slug": "obs-e2e-343",
        ...identity,
      },
      {
        path: "/obs-e2e-343/repositories",
        route: "/$orgSlug/repositories",
        "ctxpipe.org.slug": "obs-e2e-343",
        ...identity,
      },
    ])

    const firstViewIndex = addAction.mock.calls.findIndex(
      (call) => call[0] === "page_view",
    )
    expect(setGlobalAttributes.mock.invocationCallOrder[0]).toBeLessThan(
      addAction.mock.invocationCallOrder[firstViewIndex] ?? 0,
    )
    expect(setGlobalAttributes).toHaveBeenCalledWith(identity)
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "proxy",
        disableIntercom: true,
        url: `${window.location.origin}/.otel`,
        instrumentations: {
          document: true,
          postload: true,
          webvitals: true,
          errors: true,
          interactions: false,
          longtask: false,
        },
      }),
    )
    expect(init.mock.calls[0]?.[0]?.instrumentations).not.toHaveProperty(
      "fetch",
    )
    expect(init.mock.calls[0]?.[0]?.instrumentations).not.toHaveProperty("xhr")
    const targets = init.mock.calls[0]?.[0]?.tracePropagationTargets as
      | RegExp[]
      | undefined
    expect(
      targets?.some((target) =>
        target.test("/obs-e2e-343/api/v1/repositories"),
      ),
    ).toBe(true)
    expect(
      targets?.some((target) =>
        target.test(`${window.location.origin}/.auth/api/v1/auth/get-session`),
      ),
    ).toBe(true)
    expect(
      targets?.some((target) => target.test("https://evil.example/api")),
    ).toBe(false)
  })

  it("still records a client navigation when a later loader result is disabled", async () => {
    retainServerHyperDxConfig({
      enabled: true,
      environment: "pr-343",
    })
    const runtimeConfig = { enabled: false as const }
    const rootRoute = createRootRoute({
      component: () => (
        <HyperDxProvider runtimeConfig={runtimeConfig}>
          <HyperDxPageView runtimeConfig={runtimeConfig} />
          <Outlet />
        </HyperDxProvider>
      ),
    })
    const homeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <p>Home</p>,
    })
    const chatRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/chat",
      component: () => <p>Chat</p>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([homeRoute, chatRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<RouterProvider router={router} />)
    })
    await act(async () => {
      await router.navigate({ href: "/chat" })
    })
    const paths = addAction.mock.calls
      .filter((call) => call[0] === "page_view")
      .map((call) => call[1]?.path)
    expect(paths).toEqual(["/", "/chat"])
  })

  it("applies cached teamId for the org slug before the session request returns", async () => {
    sessionState.pending = true
    orgState.data = undefined
    setHyperDxGlobalAttributes(
      { userId: "user_1", teamId: "org_a", teamName: "alpha" },
      {
        organizations: [
          { id: "org_a", slug: "alpha" },
          { id: "org_b", slug: "beta" },
        ],
      },
    )
    setGlobalAttributes.mockClear()

    const runtimeConfig = { enabled: true as const, environment: "test" }
    const rootRoute = createRootRoute({
      component: () => (
        <HyperDxProvider runtimeConfig={runtimeConfig}>
          <HyperDxPageView runtimeConfig={runtimeConfig} />
          <Outlet />
        </HyperDxProvider>
      ),
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
    const router = createRouter({
      routeTree: rootRoute.addChildren([orgRoute.addChildren([indexRoute])]),
      history: createMemoryHistory({ initialEntries: ["/beta"] }),
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<RouterProvider router={router} />)
    })

    expect(setGlobalAttributes).toHaveBeenCalledWith({
      userId: "user_1",
      teamId: "org_b",
      teamName: "beta",
    })
    expect(
      addAction.mock.calls.filter((call) => call[0] === "page_view"),
    ).toEqual([])
    const identityOrder = setGlobalAttributes.mock.invocationCallOrder[0] ?? 0
    const initOrder = init.mock.invocationCallOrder[0] ?? 0
    expect(initOrder).toBeLessThan(identityOrder)
  })
})
