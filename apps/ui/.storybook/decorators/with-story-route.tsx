import type { Decorator } from "@storybook/react-vite"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { type ComponentType, type ReactElement, useMemo, useRef } from "react"

function storyRouteStub() {
  return null
}

/** Where to mount the story component in an in-memory router. */
export type StoryRouteParams =
  | { pattern: "flat"; path: string }
  | { pattern: "orgIndex"; orgSlug: string }
  | { pattern: "orgConnectors"; orgSlug: string }
  | { pattern: "orgRepositories"; orgSlug: string }
  | { pattern: "orgWorkspaceNew"; orgSlug: string }
  | {
      pattern: "orgWorkspace"
      orgSlug: string
      workspaceSlug: string
      conversationId?: string
      pane?: string
    }

/**
 * Puts the story component on a real route (sign-in, onboarding, org home index)
 * so pages that use `Navigate` / layout match production paths — without testing `/` redirects.
 *
 * The memory router is created once per story mount. Recreating it on every
 * decorator render (Storybook actions, arg updates) resets `?pane=` and is why
 * file tabs appeared but never selected. `storybook-addon-tanstack-router`'s
 * `withTanStackRouter` has the same recreate-on-render behaviour — we keep our
 * own provider and do not nest that decorator.
 */
export const withStoryRoute: Decorator = (Story, context) => {
  const spec = context.parameters.storyRoute as StoryRouteParams | undefined
  if (!spec) return <Story />
  return <StoryRouteProvider key={context.id} spec={spec} Story={Story} />
}

function StoryRouteProvider(props: {
  spec: StoryRouteParams
  Story: ComponentType
}) {
  const storyRef = useRef(props.Story)
  storyRef.current = props.Story
  const specKey = JSON.stringify(props.spec)
  const router = useMemo(
    () =>
      createStoryRouter(JSON.parse(specKey) as StoryRouteParams, () => {
        const Latest = storyRef.current
        return <Latest />
      }),
    [specKey],
  )
  return <RouterProvider router={router} />
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
    return createRouter({
      routeTree: rootRoute.addChildren(siblings),
      history: createMemoryHistory({ initialEntries: [spec.path] }),
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
    // thread does not remount AppShell / the files pane.
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
    ]),
  ])
  const workspaceSearch =
    spec.pattern === "orgWorkspace" && spec.pane
      ? `?pane=${encodeURIComponent(spec.pane)}`
      : ""
  const initialPath =
    spec.pattern === "orgConnectors"
      ? `/${spec.orgSlug}/connectors`
      : spec.pattern === "orgRepositories"
        ? `/${spec.orgSlug}/repositories`
        : spec.pattern === "orgWorkspaceNew"
          ? `/${spec.orgSlug}/workspaces/new`
          : spec.pattern === "orgWorkspace"
            ? spec.conversationId
              ? `/${spec.orgSlug}/ws/${spec.workspaceSlug}/${spec.conversationId}${workspaceSearch}`
              : `/${spec.orgSlug}/ws/${spec.workspaceSlug}${workspaceSearch}`
            : `/${spec.orgSlug}`
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
}
