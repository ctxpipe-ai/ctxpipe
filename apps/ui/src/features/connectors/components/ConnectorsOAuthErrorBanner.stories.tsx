import { oauthErrorMessage } from "@/lib/atlassian-oauth-messages"

import preview from "../../../../.storybook/preview"
import { ConnectorsOAuthErrorBanner } from "./ConnectorsOAuthErrorBanner"

const meta = preview.meta({
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
})

/**
 * Error banner on the Connectors page after a failed Atlassian OAuth link: the
 * account is already linked to a different user.
 */
export const AccountAlreadyLinkedToDifferentUser = meta.story({
  args: oauthErrorMessage("account_already_linked_to_different_user"),
})

/**
 * Error banner on the Connectors page after a failed Atlassian OAuth link:
 * ctxpipe could not link the account.
 */
export const UnableToLinkAccount = meta.story({
  args: oauthErrorMessage("unable_to_link_account"),
})

/**
 * Error banner on the Connectors page after a failed Atlassian OAuth link: the
 * account email does not match the user email.
 */
export const EmailDoesNotMatch = meta.story({
  args: oauthErrorMessage("email_doesn't_match"),
})

/**
 * Error alert at the top of the Connectors page after an account link returns
 * with an expired or invalid code: it tells the user to start the connection
 * again.
 */
export const InvalidCode = meta.story({
  args: oauthErrorMessage("invalid_code"),
})

/**
 * Error alert at the top of the Connectors page after an account link returns
 * with a state that does not match: it tells the user to start again in this
 * browser window.
 */
export const StateMismatch = meta.story({
  args: oauthErrorMessage("state_mismatch"),
})

/**
 * Error banner on the Connectors page after a failed Atlassian OAuth link: an
 * unknown error code with a detail text from the provider.
 */
export const UnknownErrorWithDescription = meta.story({
  args: oauthErrorMessage(
    "custom_provider_error",
    "Additional detail from the provider.",
  ),
})

/**
 * Error alert at the top of the Connectors page after an account link fails
 * with an unknown code and no detail: the generic text asks for a new start and
 * gives the code.
 */
export const UnknownErrorFallback = meta.story({
  args: oauthErrorMessage("unknown_code", null),
})
