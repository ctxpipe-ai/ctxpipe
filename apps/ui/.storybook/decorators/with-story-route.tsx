import type { Decorator } from "@storybook/react-vite"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"

function storyRouteStub() {
  return null
}

/** Where to mount the story component in an in-memory router. */
export type StoryRouteParams =
  | { pattern: "flat"; path: string }
  | { pattern: "orgIndex"; orgSlug: string }

/**
 * Puts the story component on a real route (sign-in, onboarding, org home index)
 * so pages that use `Navigate` / layout match production paths — without testing `/` redirects.
 */
export const withStoryRoute: Decorator = (Story, context) => {
  const spec = context.parameters.storyRoute as StoryRouteParams | undefined
  if (!spec) return <Story />

  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  })

  if (spec.pattern === "flat") {
    const leaf = createRoute({
      getParentRoute: () => rootRoute,
      path: spec.path,
      component: Story,
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
    const routeTree = rootRoute.addChildren(siblings)
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [spec.path] }),
    })
    return <RouterProvider router={router} />
  }

  const orgRoute = createRoute({
    getParentRoute: () => rootRoute,
    /** Path segment relative to root — `/$orgSlug` does not match `/acme` (notFound on org layout). */
    path: "$orgSlug",
    component: () => <Outlet />,
  })
  const orgIndex = createRoute({
    getParentRoute: () => orgRoute,
    path: "/",
    component: Story,
  })
  const orgChat = createRoute({
    getParentRoute: () => orgRoute,
    path: "chat",
    component: () => <Outlet />,
  })
  const orgChatIndex = createRoute({
    getParentRoute: () => orgChat,
    path: "/",
    component: storyRouteStub,
  })
  const orgRepositories = createRoute({
    getParentRoute: () => orgRoute,
    path: "repositories",
    component: () => <Outlet />,
  })
  const orgRepositoriesIndex = createRoute({
    getParentRoute: () => orgRepositories,
    path: "/",
    component: storyRouteStub,
  })
  const orgConnectors = createRoute({
    getParentRoute: () => orgRoute,
    path: "connectors",
    component: storyRouteStub,
  })
  const orgKnowledgeGraph = createRoute({
    getParentRoute: () => orgRoute,
    path: "knowledge-graph",
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
      orgKnowledgeGraph,
      orgChat.addChildren([orgChatIndex]),
      orgRepositories.addChildren([orgRepositoriesIndex]),
    ]),
  ])
  const initialPath = `/${spec.orgSlug}`
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  return <RouterProvider router={router} />
}
