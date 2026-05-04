import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { generateGithubWebhookSecret } from "@/lib/github-webhook-secret"
import { GithubSelfHostedCredentialsStep } from "./GithubSelfHostedCredentialsStep"

const meta = {
  title: "Components/Connections/GitHub/SelfHostedCredentials",
  component: GithubSelfHostedCredentialsStep,
  parameters: { layout: "padded" },
} satisfies Meta<typeof GithubSelfHostedCredentialsStep>

export default meta

type Story = StoryObj<typeof meta>

function Interactive() {
  const [githubAppId, setGithubAppId] = useState("")
  const [appSlug, setAppSlug] = useState("my-app")
  const [privateKey, setPrivateKey] = useState("")
  const [generatedWebhookSecret] = useState(generateGithubWebhookSecret)
  return (
    <GithubSelfHostedCredentialsStep
      githubAppId={githubAppId}
      setGithubAppId={setGithubAppId}
      appSlug={appSlug}
      setAppSlug={setAppSlug}
      privateKey={privateKey}
      setPrivateKey={setPrivateKey}
      generatedWebhookSecret={generatedWebhookSecret}
      payloadUrl={`${window.location.origin}/api/v1/webhook/github/con_01storydemo`}
      payloadUrlLoading={false}
      payloadUrlError={null}
      draftPending={false}
      onSubmit={() => {}}
      onCancel={() => {}}
    />
  )
}

export const SelfHostedCredentials: Story = {
  render: () => <Interactive />,
}
