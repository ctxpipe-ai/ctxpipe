import type { Meta, StoryObj } from "@storybook/react-vite"
import { oauthErrorMessage } from "@/lib/atlassian-oauth-messages"
import { ConnectorsOAuthErrorBanner } from "./ConnectorsOAuthErrorBanner"

const meta = {
  title: "Components/Connections/ConnectorsOAuthErrorBanner",
  component: ConnectorsOAuthErrorBanner,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ConnectorsOAuthErrorBanner>

export default meta

type Story = StoryObj<typeof meta>

export const AccountAlreadyLinkedToDifferentUser: Story = {
  args: oauthErrorMessage("account_already_linked_to_different_user"),
}

export const UnableToLinkAccount: Story = {
  args: oauthErrorMessage("unable_to_link_account"),
}

export const EmailDoesNotMatch: Story = {
  args: oauthErrorMessage("email_doesn't_match"),
}

export const InvalidCode: Story = {
  args: oauthErrorMessage("invalid_code"),
}

export const StateMismatch: Story = {
  args: oauthErrorMessage("state_mismatch"),
}

export const UnknownErrorWithDescription: Story = {
  args: oauthErrorMessage(
    "custom_provider_error",
    "Additional detail from the provider.",
  ),
}

export const UnknownErrorFallback: Story = {
  args: oauthErrorMessage("unknown_code", null),
}
