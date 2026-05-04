import type { Meta, StoryObj } from "@storybook/react-vite"
import { GithubSelfHostedInstallStep } from "./GithubSelfHostedInstallStep"

const meta = {
  title: "Components/Connections/GithubSelfHostedInstallStep",
  component: GithubSelfHostedInstallStep,
  parameters: { layout: "centered" },
} satisfies Meta<typeof GithubSelfHostedInstallStep>

export default meta

type Story = StoryObj<typeof meta>

export const WithWebhookUrl: Story = {
  args: {
    webhookUrl:
      "https://app.example.com/api/v1/webhook/github/con_01hzexample123",
    onBack: () => {},
    onOpenGitHubInstall: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-[min(92vw,520px)] rounded-none border border-border bg-card/30 p-4">
        <Story />
      </div>
    ),
  ],
}

export const MissingWebhookUrl: Story = {
  args: {
    webhookUrl: null,
    onBack: () => {},
    onOpenGitHubInstall: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-[min(92vw,520px)] rounded-none border border-border bg-card/30 p-4">
        <Story />
      </div>
    ),
  ],
}
