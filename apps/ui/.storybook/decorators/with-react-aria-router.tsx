import type { Decorator } from "@storybook/react-vite"
import { useRouter } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { RouterProvider } from "react-aria-components"

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

export const withReactAriaRouter: Decorator = (Story) => (
  <ReactAriaRouterBridge>
    <Story />
  </ReactAriaRouterBridge>
)
