import type { Decorator } from "@storybook/react-vite"
import { useRouter } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { RouterProvider } from "react-aria-components"

import { AppShell } from "@/components/AppShell"
import { AuthProvider } from "@/providers/AuthProvider"
import { HyperDxProvider } from "@/providers/HyperDxProvider"

function ReactAriaRouterBridge({ children }: { children: ReactNode }) {
  const router = useRouter()
  return (
    <RouterProvider
      navigate={(href) => {
        void router.navigate({ href })
      }}
      useHref={(href) => href}
    >
      {children}
    </RouterProvider>
  )
}

/**
 * `parameters.app` (opt-in): the providers of the app around the story.
 * - `"root"`: the providers of `__root.tsx`: auth, HyperDX (off) and the
 *   React Aria router.
 * - `"org"`: the same, and the `AppShell` of the `/$orgSlug` layout.
 *
 * The providers read the router (`parameters.storyRoute`) and the Query
 * client (`parameters.queryClient`), so a story sets both.
 */
export const withApp: Decorator = (Story, { parameters }) => (
  <AuthProvider>
    <HyperDxProvider runtimeConfig={{ enabled: false }}>
      <ReactAriaRouterBridge>
        {parameters.app === "org" ? (
          <AppShell>
            <Story />
          </AppShell>
        ) : (
          <Story />
        )}
      </ReactAriaRouterBridge>
    </HyperDxProvider>
  </AuthProvider>
)
