import type { Meta, StoryObj } from "@storybook/react-vite"

import { oauthErrorMessage } from "@/lib/atlassian-oauth-messages"

import { ConnectorsOAuthErrorBanner } from "./ConnectorsOAuthErrorBanner"

const meta = {
  title: "Components/Connections/OAuthErrorBanner",
  component: ConnectorsOAuthErrorBanner,
  parameters: {
    layout: "centered",
    review: { kind: "component" },
  },
} satisfies Meta<typeof ConnectorsOAuthErrorBanner>

export default meta

type Story = StoryObj<typeof meta>

export const AccountAlreadyLinkedToDifferentUser: Story = {
  parameters: {
    review: {
      purpose:
        "Error banner on the Connectors page after a failed Atlassian OAuth link: the account is already linked to a different user.",
    },
  },
  args: oauthErrorMessage("account_already_linked_to_different_user"),
}

export const UnableToLinkAccount: Story = {
  parameters: {
    review: {
      purpose:
        "Error banner on the Connectors page after a failed Atlassian OAuth link: ctxpipe could not link the account.",
    },
  },
  args: oauthErrorMessage("unable_to_link_account"),
}

export const EmailDoesNotMatch: Story = {
  parameters: {
    review: {
      purpose:
        "Error banner on the Connectors page after a failed Atlassian OAuth link: the account email does not match the user email.",
    },
  },
  args: oauthErrorMessage("email_doesn't_match"),
}

export const InvalidCode: Story = {
  parameters: {
    review: {
      purpose:
        "Error banner on the Connectors page after a failed Atlassian OAuth link: the OAuth code is not valid.",
    },
  },
  args: oauthErrorMessage("invalid_code"),
}

export const StateMismatch: Story = {
  parameters: {
    review: {
      purpose:
        "Error banner on the Connectors page after a failed Atlassian OAuth link: the OAuth state does not match.",
    },
  },
  args: oauthErrorMessage("state_mismatch"),
}

export const UnknownErrorWithDescription: Story = {
  parameters: {
    review: {
      purpose:
        "Error banner on the Connectors page after a failed Atlassian OAuth link: an unknown error code with a detail text from the provider.",
    },
  },
  args: oauthErrorMessage(
    "custom_provider_error",
    "Additional detail from the provider.",
  ),
}

export const UnknownErrorFallback: Story = {
  parameters: {
    review: {
      purpose:
        "Error banner on the Connectors page after a failed Atlassian OAuth link: an unknown error code with no detail, so the generic text shows.",
    },
  },
  args: oauthErrorMessage("unknown_code", null),
}
