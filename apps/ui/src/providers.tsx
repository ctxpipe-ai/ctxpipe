import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack"
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Link, useRouter } from "@tanstack/react-router"
import { RouterProvider } from "react-aria-components"
import type { ReactNode } from "react"
import { authClient } from "@/lib/auth-client"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
    },
  },
})

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter()
  const firstSegment = router.state.location.pathname
    .split("/")
    .filter(Boolean)[0]
  const orgSlug =
    firstSegment && !firstSegment.startsWith(".") ? firstSegment : undefined

  return (
    <QueryClientProvider client={queryClient}>
      <AuthQueryProvider>
        <AuthUIProviderTanstack
          authClient={authClient}
          navigate={(href) => router.navigate({ href })}
          replace={(href) => router.navigate({ href, replace: true })}
          persistClient={false}
          organization={{
            slug: orgSlug,
          }}
          onSessionChange={() => {
            void router.invalidate()
          }}
          Link={({ href, ...props }) => <Link to={href} {...props} />}
        >
          <RouterProvider
            navigate={(href) => {
              void router.navigate({ href })
            }}
            useHref={(href) => href}
          >
            {children}
          </RouterProvider>
        </AuthUIProviderTanstack>
      </AuthQueryProvider>
    </QueryClientProvider>
  )
}
