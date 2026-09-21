import type { Meta, StoryObj } from "@storybook/react-vite"
import { ConnectorContextRepositoryGuidance } from "./ConnectorContextRepositoryGuidance"

const meta = {
  title: "Components/Connections/ContextRepositoryGuidance",
  component: ConnectorContextRepositoryGuidance,
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl bg-zinc-950 p-6 text-zinc-100">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ConnectorContextRepositoryGuidance>

export default meta

type Story = StoryObj<typeof meta>

export const ConnectorPanel: Story = {}

export const Onboarding: Story = {
  args: {
    variant: "onboarding",
  },
}

export const OnboardingFound: Story = {
  args: {
    variant: "onboarding",
    foundRepositoryName: "acme/ctxpipe-context",
  },
}
