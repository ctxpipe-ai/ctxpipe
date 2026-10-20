import type { Preview } from "@storybook/react-vite"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { initialize, mswLoader } from "msw-storybook-addon"
import { type ReactElement, Suspense, useMemo } from "react"
import {
  authConfigHandler,
  organizationListWithOrgHandler,
  sessionSignedInHandler,
} from "../src/mocks/handlers"
import { pendingWorkspaceUpgradesHandler } from "../src/mocks/workspace-upgrades-handlers"
import { storyRouteLoader } from "./decorators/with-story-route"
import "../src/styles.css"

initialize({ onUnhandledRequest: "bypass" })

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
  beforeEach: () => {
    window.localStorage.clear()
    window.sessionStorage.clear()
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
