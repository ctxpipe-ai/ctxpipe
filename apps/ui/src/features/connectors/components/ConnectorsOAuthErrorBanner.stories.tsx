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
  // The width of the Connectors page column, above the page title.
  decorators: [
    (Story) => (
      <div className="w-xl max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConnectorsOAuthErrorBanner>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Error banner on the Connectors page after a failed Atlassian OAuth link: the
 * account is already linked to a different user.
 */
export const AccountAlreadyLinkedToDifferentUser: Story = {
  args: oauthErrorMessage("account_already_linked_to_different_user"),
}

/**
 * Error banner on the Connectors page after a failed Atlassian OAuth link:
 * ctxpipe could not link the account.
 */
export const UnableToLinkAccount: Story = {
  args: oauthErrorMessage("unable_to_link_account"),
}

/**
 * Error banner on the Connectors page after a failed Atlassian OAuth link: the
 * account email does not match the user email.
 */
export const EmailDoesNotMatch: Story = {
  args: oauthErrorMessage("email_doesn't_match"),
}

/**
 * Error alert at the top of the Connectors page after an account link returns
 * with an expired or invalid code: it tells the user to start the connection
 * again.
 */
export const InvalidCode: Story = {
  args: oauthErrorMessage("invalid_code"),
}

/**
 * Error alert at the top of the Connectors page after an account link returns
 * with a state that does not match: it tells the user to start again in this
 * browser window.
 */
export const StateMismatch: Story = {
  args: oauthErrorMessage("state_mismatch"),
}

/**
 * Error banner on the Connectors page after a failed Atlassian OAuth link: an
 * unknown error code with a detail text from the provider.
 */
export const UnknownErrorWithDescription: Story = {
  args: oauthErrorMessage(
    "custom_provider_error",
    "Additional detail from the provider.",
  ),
}

/**
 * Error alert at the top of the Connectors page after an account link fails
 * with an unknown code and no detail: the generic text asks for a new start and
 * gives the code.
 */
export const UnknownErrorFallback: Story = {
  args: oauthErrorMessage("unknown_code", null),
}
