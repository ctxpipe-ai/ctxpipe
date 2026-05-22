import type { Preview } from "@storybook/react-vite"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { initialize, mswLoader } from "msw-storybook-addon"
import { type ReactElement, useMemo } from "react"
import {
  authConfigHandler,
  organizationListWithOrgHandler,
  sessionSignedInHandler,
} from "../src/mocks/handlers"
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
}

function StorybookQueryBoundary({ children }: { children: React.ReactNode }) {
  const client = useMemo(
    () =>
      new QueryClient({
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
      }),
    [],
  )
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const preview: Preview = {
  loaders: [mswLoader],
  decorators: [
    (Story, { id }): ReactElement => (
      <div className="min-h-screen bg-background font-sans text-foreground antialiased">
        <StorybookQueryBoundary key={id}>
          <Story />
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
