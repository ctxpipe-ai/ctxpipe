import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "react-aria-components"
import type { ReactNode } from "react"
import { AuthProvider } from "./providers/AuthProvider"
import { useRouter } from "@tanstack/react-router"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
    },
  },
})

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter()
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider
          navigate={(href) => {
            void router.navigate({ href })
          }}
          useHref={(href) => href}
        >
          {children}
        </RouterProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
