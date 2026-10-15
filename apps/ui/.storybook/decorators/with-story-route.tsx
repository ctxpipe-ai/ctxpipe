import type { Decorator } from "@storybook/react-vite"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import type { ComponentType, ReactElement } from "react"

function storyRouteStub() {
  return null
}

/** Where to mount the story component in an in-memory router. */
export type StoryRouteParams =
  | {
      pattern: "flat"
      path: string
      /** Query string of the first entry, with its leading `?`. */
      search?: string
      /** More paths that also render the story, so a play can follow a navigation. */
      alsoAt?: string[]
    }
  | { pattern: "orgIndex"; orgSlug: string; search?: string }
  | { pattern: "orgConnectors"; orgSlug: string; search?: string }
  | { pattern: "orgRepositories"; orgSlug: string }
  | { pattern: "orgWorkspaceNew"; orgSlug: string }
  | {
      pattern: "orgWorkspace"
      orgSlug: string
      workspaceSlug: string
      conversationId?: string
      pane?: string
    }

type LoadedStoryRoute = {
  router: ReturnType<typeof createStoryRouter>
  /** The decorator keeps the latest story component here; the route renders it. */
  story: { current: ComponentType }
}

/**
 * Builds the story router and loads its first route before the story renders.
 * Without this, the router renders its first route after an async load, and a
 * play that starts at once finds an empty canvas. The router is built once per
 * story run: recreating it on a decorator render (Storybook actions, arg
 * updates) resets `?pane=` and is why file tabs appeared but never selected.
 */
export const storyRouteLoader = async (context: {
  parameters: Record<string, unknown>
}): Promise<{ storyRoute?: LoadedStoryRoute }> => {
  const spec = context.parameters.storyRoute as StoryRouteParams | undefined
  if (!spec) return {}
  const story = { current: storyRouteStub as ComponentType }
  const router = createStoryRouter(spec, () => {
    const Latest = story.current
    return <Latest />
  })
  await router.load()
  return { storyRoute: { router, story } }
}

/**
 * Puts the story component on a real route (sign-in, onboarding, org home index)
 * so pages that use `Navigate` / layout match production paths — without testing `/` redirects.
 * `storyRouteLoader` builds the router. `storybook-addon-tanstack-router`'s
 * `withTanStackRouter` has the same recreate-on-render behaviour — we keep our
 * own provider and do not nest that decorator.
 */
export const withStoryRoute: Decorator = (Story, context) => {
  const loaded = (context.loaded as { storyRoute?: LoadedStoryRoute })
    .storyRoute
  if (!loaded) return <Story />
  loaded.story.current = Story
  return <RouterProvider key={context.id} router={loaded.router} />
}

function createStoryRouter(
  spec: StoryRouteParams,
  renderStory: () => ReactElement,
) {
  const StoryRoute = () => renderStory()
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  })

  if (spec.pattern === "flat") {
    const leaf = createRoute({
      getParentRoute: () => rootRoute,
      path: spec.path,
      component: StoryRoute,
    })
    const siblings =
      spec.path === "/.auth/sign-in"
        ? [leaf]
        : [
            createRoute({
              getParentRoute: () => rootRoute,
              path: "/.auth/sign-in",
              component: storyRouteStub,
            }),
            leaf,
          ]
    const extra = (spec.alsoAt ?? []).map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        component: StoryRoute,
      }),
    )
    return createRouter({
      routeTree: rootRoute.addChildren([...siblings, ...extra]),
      history: createMemoryHistory({
        initialEntries: [`${spec.path}${spec.search ?? ""}`],
      }),
    })
  }

  const orgRoute = createRoute({
    getParentRoute: () => rootRoute,
    /** Path segment relative to root — `/$orgSlug` does not match `/acme` (notFound on org layout). */
    path: "$orgSlug",
    component: () => <Outlet />,
  })
  const orgIndexForStory =
    spec.pattern === "orgIndex" ? StoryRoute : storyRouteStub
  const orgConnectorsForStory =
    spec.pattern === "orgConnectors" ? StoryRoute : storyRouteStub
  const orgRepositoriesIndexForStory =
    spec.pattern === "orgRepositories" ? StoryRoute : storyRouteStub

  const orgIndex = createRoute({
    getParentRoute: () => orgRoute,
    path: "/",
    component: orgIndexForStory,
  })
  const orgRepositories = createRoute({
    getParentRoute: () => orgRoute,
    path: "repositories",
    component: () => <Outlet />,
  })
  const orgRepositoriesIndex = createRoute({
    getParentRoute: () => orgRepositories,
    path: "/",
    component: orgRepositoriesIndexForStory,
  })
  const orgConnectors = createRoute({
    getParentRoute: () => orgRoute,
    path: "connectors",
    component: orgConnectorsForStory,
  })
  const orgWorkspaceNewForStory =
    spec.pattern === "orgWorkspaceNew" ? StoryRoute : storyRouteStub
  const orgWorkspacesNew = createRoute({
    getParentRoute: () => orgRoute,
    path: "workspaces/new",
    component: orgWorkspaceNewForStory,
  })
  const orgWs = createRoute({
    getParentRoute: () => orgRoute,
    path: "ws/$workspaceSlug",
    validateSearch: (search: Record<string, unknown>) => ({
      pane: typeof search.pane === "string" ? search.pane : undefined,
    }),
    // Same as production: the workspace layout owns the surface so compose ↔
    // thread does not remount the files pane. Org AppShell is the page decorator.
    component: spec.pattern === "orgWorkspace" ? StoryRoute : () => <Outlet />,
  })
  const orgWsIndex = createRoute({
    getParentRoute: () => orgWs,
    path: "/",
    component: storyRouteStub,
  })
  const orgWsConversation = createRoute({
    getParentRoute: () => orgWs,
    path: "$conversationId",
    component: storyRouteStub,
  })
  const orgOrganization = createRoute({
    getParentRoute: () => orgRoute,
    path: "organization",
    component: () => <Outlet />,
  })
  const orgOrganizationView = createRoute({
    getParentRoute: () => orgOrganization,
    path: "$organizationView",
    component: storyRouteStub,
  })
  /** So `Navigate` from org pages (session/onboarding gates) never hits a missing route before MSW resolves. */
  const authSignInStub = createRoute({
    getParentRoute: () => rootRoute,
    path: "/.auth/sign-in",
    component: storyRouteStub,
  })
  const onboardingStub = createRoute({
    getParentRoute: () => rootRoute,
    path: "onboarding",
    component: storyRouteStub,
  })
  const routeTree = rootRoute.addChildren([
    authSignInStub,
    onboardingStub,
    orgRoute.addChildren([
      orgIndex,
      orgConnectors,
      orgWorkspacesNew,
      orgWs.addChildren([orgWsIndex, orgWsConversation]),
      orgRepositories.addChildren([orgRepositoriesIndex]),
      orgOrganization.addChildren([orgOrganizationView]),
    ]),
  ])
  const workspaceSearch =
    spec.pattern === "orgWorkspace" && spec.pane
      ? `?pane=${encodeURIComponent(spec.pane)}`
      : ""
  const initialPath =
    spec.pattern === "orgConnectors"
      ? `/${spec.orgSlug}/connectors${spec.search ?? ""}`
      : spec.pattern === "orgRepositories"
        ? `/${spec.orgSlug}/repositories`
        : spec.pattern === "orgWorkspaceNew"
          ? `/${spec.orgSlug}/workspaces/new`
          : spec.pattern === "orgWorkspace"
            ? spec.conversationId
              ? `/${spec.orgSlug}/ws/${spec.workspaceSlug}/${spec.conversationId}${workspaceSearch}`
              : `/${spec.orgSlug}/ws/${spec.workspaceSlug}${workspaceSearch}`
            : `/${spec.orgSlug}${spec.pattern === "orgIndex" ? (spec.search ?? "") : ""}`
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
}
