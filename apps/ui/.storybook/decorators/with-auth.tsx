import type { Decorator } from "@storybook/react-vite"
import { AuthProvider } from "@/providers/AuthProvider"

export const withAuth: Decorator = (Story) => (
  <AuthProvider>
    <Story />
  </AuthProvider>
)
