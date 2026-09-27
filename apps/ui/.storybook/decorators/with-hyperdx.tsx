import type { Decorator } from "@storybook/react-vite"
import { HyperDxProvider } from "@/providers/HyperDxProvider"

export const withHyperDx: Decorator = (Story) => (
  <HyperDxProvider runtimeConfig={{ enabled: false }}>
    <Story />
  </HyperDxProvider>
)
