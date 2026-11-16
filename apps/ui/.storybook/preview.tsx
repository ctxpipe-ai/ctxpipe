import type { Preview } from "@storybook/react-vite"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { HttpResponse, isCommonAssetRequest } from "msw"
import { getWorker, initialize, mswLoader } from "msw-storybook-addon"
import { type ReactElement, Suspense, useMemo } from "react"

import { layoutProblems } from "../src/lib/layout-checks"
import {
  authConfigHandler,
  organizationFullWithOrgHandler,
  organizationListWithOrgHandler,
  sessionSignedInHandler,
} from "../src/mocks/handlers"
import { workspaceIngestionHandlers } from "../src/mocks/workspace-ingestion-handlers"
import { activeMemberRoleHandler } from "../src/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "../src/mocks/workspace-upgrades-handlers"
import { storyRouteLoader } from "./decorators/with-story-route"

import "../src/styles.css"

// A story must mock each request of its page (the storybook skill, "Mock
// every request"). A request that no handler answers fails with a network
// error, and the play runner (scripts/ci/storybook-play.mjs) fails the story
// that made it. A static asset (a script, a style, a font, an image, a
// WebAssembly module) of the Storybook server or of a CDN goes to the
// network. An API path (`/api/`) is never an asset, also when it ends in
// `.md` or `.json`.
//
// The initial handlers answer the org of the signed-in story user. Each page
// under `/$orgSlug` reads them. Any handler of a story, in any key, comes
// before them.
const unhandledRequests: string[] = []
initialize(
  {
    onUnhandledRequest(request, print) {
      const { pathname } = new URL(request.url)
      if (
        (isCommonAssetRequest(request) || pathname.endsWith(".wasm")) &&
        !pathname.includes("/api/")
      )
        return
      unhandledRequests.push(`${request.method} ${request.url}`)
      print.error()
      // MSW resolves the request with what the callback throws: a network
      // error, so the request never reaches a server.
      throw HttpResponse.error()
    },
  },
  [organizationFullWithOrgHandler, activeMemberRoleHandler("admin")],
)

// The check runner (scripts/checks/README.md) records which MSW handlers
// answered a request of the story. A handler header is `<METHOD> <path>`.
// The screenshot capture (scripts/ci/visual-capture.mjs) runs the layout
// checks of each story. The play runner reads the unhandled requests.
Object.assign(window, {
  __ctxpipeLayoutProblems: layoutProblems,
  __ctxpipeUnhandledRequests: unhandledRequests,
  __ctxpipeMswHandlers: () =>
    getWorker()
      .listHandlers()
      .flatMap((handler) =>
        "isUsed" in handler && handler.isUsed ? [handler.info.header] : [],
      ),
})

const storybookDefaultMswHandlers = {
  defaults: [
    authConfigHandler,
    sessionSignedInHandler({
      id: "user_storybook",
      onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
    }),
    organizationListWithOrgHandler,
  ],
  // No Workspace has a pending upgrade. The connect flows read it before
  // they offer a Workspace (CTX-935); a story sets this key to change it.
  pendingUpgrades: [pendingWorkspaceUpgradesHandler({})],
  // No Workspace ingests now: the sidebar shows no pulse. A story sets this
  // key to change it (CTX-959).
  ingestion: workspaceIngestionHandlers({}),
}

function StorybookQueryBoundary({ children }: { children: React.ReactNode }) {
  const client = useMemo(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 0,
          gcTime: 0,
          /** MSW error stories should reflect `delay()` timing, not exponential backoff (≈1s+2s+4s). */
          retry: false,
        },
        mutations: {
          retry: false,
        },
      },
    })
    // The first message of a new conversation waits in the cache until its
    // session mounts. A zero gcTime would drop it first; production keeps the default.
    client.setQueryDefaults(["conversation-start"], {
      gcTime: Number.POSITIVE_INFINITY,
    })
    return client
  }, [])
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const preview: Preview = {
  // One browser runs every story, so stored UI state would leak to the next
  // story. The user preferences hold the SideNav width and collapse, the
  // setup-guide dismissal and the seen hints. Session storage holds drafts.
  // The Query client is built per story, and a story has no theme state.
  // The list of unhandled requests is emptied when the story closes, so that
  // the requests of the story loaders stay in it.
  beforeEach: () => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    return () => {
      unhandledRequests.length = 0
    }
  },
  loaders: [mswLoader, storyRouteLoader],
  decorators: [
    (Story, { id }): ReactElement => (
      <div className="min-h-screen bg-background font-sans text-foreground antialiased">
        <StorybookQueryBoundary key={id}>
          <Suspense
            fallback={
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            }
          >
            <Story />
          </Suspense>
        </StorybookQueryBoundary>
      </div>
    ),
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    msw: {
      handlers: storybookDefaultMswHandlers,
    },
  },
}

export default preview
