import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { GithubSelfHostedCredentialsStep } from "./GithubSelfHostedCredentialsStep"

const meta = {
  title: "Components/Connections/GithubSelfHostedCredentialsStep",
  component: GithubSelfHostedCredentialsStep,
  parameters: { layout: "centered" },
} satisfies Meta<typeof GithubSelfHostedCredentialsStep>

export default meta

type Story = StoryObj<typeof meta>

function Interactive() {
  const [githubAppId, setGithubAppId] = useState("")
  const [appSlug, setAppSlug] = useState("my-app")
  const [privateKey, setPrivateKey] = useState("")
  const [webhookSecret, setWebhookSecret] = useState("")
  return (
    <div className="w-[min(92vw,520px)] rounded-none border border-border bg-card/30 p-4">
      <GithubSelfHostedCredentialsStep
        githubAppId={githubAppId}
        setGithubAppId={setGithubAppId}
        appSlug={appSlug}
        setAppSlug={setAppSlug}
        privateKey={privateKey}
        setPrivateKey={setPrivateKey}
        webhookSecret={webhookSecret}
        setWebhookSecret={setWebhookSecret}
        draftPending={false}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </div>
  )
}

export const Default: Story = {
  render: () => <Interactive />,
}
