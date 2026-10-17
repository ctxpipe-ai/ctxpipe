import { QueryClientProvider } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { RouterProvider } from "react-aria-components"
import type { ConfluenceForgeRuntimeConfig } from "@/lib/confluenceForgeRuntimeConfig"
import type { HyperDxSessionIdentity } from "@/lib/hyperdxAttributes"
import type { HyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"
import { AuthProvider } from "./providers/AuthProvider"
import { ConfluenceForgeRuntimeProvider } from "./providers/ConfluenceForgeRuntimeContext"
import { HyperDxProvider } from "./providers/HyperDxProvider"
import type { RouterContext } from "./router"

export function Providers({
  children,
  hyperdxRuntimeConfig,
  hyperdxIdentity,
  confluenceForgeRuntimeConfig,
}: {
  children: ReactNode
  hyperdxRuntimeConfig: HyperDxRuntimeConfig
  hyperdxIdentity: HyperDxSessionIdentity | null
  confluenceForgeRuntimeConfig: ConfluenceForgeRuntimeConfig
}) {
  const router = useRouter()
  const { queryClient } = router.options.context as RouterContext

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ConfluenceForgeRuntimeProvider value={confluenceForgeRuntimeConfig}>
          <HyperDxProvider
            runtimeConfig={hyperdxRuntimeConfig}
            initialIdentity={hyperdxIdentity}
          >
            <RouterProvider
              navigate={(href) => {
                void router.navigate({ href })
              }}
              useHref={(href) => href}
            >
              {children}
            </RouterProvider>
          </HyperDxProvider>
        </ConfluenceForgeRuntimeProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
