import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { RouterProvider } from "react-aria-components"
import type { AmplitudeRuntimeConfig } from "@/lib/amplitudeRuntimeConfig"
import type { ConfluenceForgeRuntimeConfig } from "@/lib/confluenceForgeRuntimeConfig"
import { AmplitudeProvider } from "./providers/AmplitudeProvider"
import { AuthProvider } from "./providers/AuthProvider"
import { ConfluenceForgeRuntimeProvider } from "./providers/ConfluenceForgeRuntimeContext"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
    },
  },
})

export function Providers({
  children,
  amplitudeRuntimeConfig,
  confluenceForgeRuntimeConfig,
}: {
  children: ReactNode
  amplitudeRuntimeConfig: AmplitudeRuntimeConfig
  confluenceForgeRuntimeConfig: ConfluenceForgeRuntimeConfig
}) {
  const router = useRouter()
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ConfluenceForgeRuntimeProvider value={confluenceForgeRuntimeConfig}>
          <AmplitudeProvider runtimeConfig={amplitudeRuntimeConfig}>
            <RouterProvider
              navigate={(href) => {
                void router.navigate({ href })
              }}
              useHref={(href) => href}
            >
              {children}
            </RouterProvider>
          </AmplitudeProvider>
        </ConfluenceForgeRuntimeProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
