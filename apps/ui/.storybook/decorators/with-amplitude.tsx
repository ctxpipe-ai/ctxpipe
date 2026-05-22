import type { Decorator } from "@storybook/react-vite"
import { AmplitudeProvider } from "@/providers/AmplitudeProvider"

export const withAmplitude: Decorator = (Story) => (
  <AmplitudeProvider runtimeConfig={{ enabled: false }}>
    <Story />
  </AmplitudeProvider>
)
