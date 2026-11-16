import type { Decorator } from "@storybook/react-vite"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { type ReactNode, useMemo } from "react"

function StoryQueryClient({ children }: { children: ReactNode }) {
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

/** `parameters.queryClient: true` (opt-in): a new Query client for each story. */
export const withQueryClient: Decorator = (Story, { id }) => (
  <StoryQueryClient key={id}>
    <Story />
  </StoryQueryClient>
)
