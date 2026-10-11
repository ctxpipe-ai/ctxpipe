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
import {
  RouterProvider as AriaRouterProvider,
  Link,
} from "react-aria-components"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ShellLayoutProvider, useSideNavLocation } from "./ShellLayoutContext"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function ActiveNav() {
  const nav = useSideNavLocation()
  return <output data-testid="active">{nav.primary}</output>
}

function createTestRouter(initialPath: string) {
  // Same React Aria router bridge as `providers.tsx`.
  const rootRoute = createRootRoute({
    component: () => (
      <AriaRouterProvider
        navigate={(href) => {
          void router.navigate({ href })
        }}
        useHref={(href) => href}
      >
        <ShellLayoutProvider>
          <ActiveNav />
          <Outlet />
        </ShellLayoutProvider>
      </AriaRouterProvider>
    ),
  })
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$orgSlug/ws/$workspaceSlug",
    component: () => (
      <Link href="/acme/connectors">Connect another source</Link>
    ),
  })
  const connectorsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$orgSlug/connectors",
    component: () => <h1>Connectors</h1>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute, connectorsRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  return router
}

describe("ShellLayoutProvider", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    // The user preferences read this browser storage.
    const store = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it("moves the active nav item when a plain link opens Connectors", async () => {
    const router = createTestRouter("/acme/ws/docs")
    await act(async () => {
      root.render(<RouterProvider router={router} />)
      await router.load()
    })
    const active = () =>
      container.querySelector('[data-testid="active"]')?.textContent

    expect(active()).toBe("workspace")

    const link = container.querySelector("a")
    if (!link) throw new Error("expected the Connectors link")
    await act(async () => link.click())

    await vi.waitFor(() =>
      expect(container.querySelector("h1")?.textContent).toBe("Connectors"),
    )
    expect(active()).toBe("connectors")
  })
})
