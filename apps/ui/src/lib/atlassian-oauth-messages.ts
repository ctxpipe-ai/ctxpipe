/**
 * Messages for the `?error=` codes of an account link (Better Auth). Every
 * provider (Atlassian, GitHub, Google, Microsoft) fails through the same
 * redirect, which does not say which provider it was, so no message names one.
 */
const KNOWN: Record<string, { title: string; description: string }> = {
  account_already_linked_to_different_user: {
    title: "This account is linked to another ctxpipe user",
    description:
      "The account that you tried to link is already linked to a different ctxpipe user. Sign in as that user and unlink it (User account → Unlink), or link a different account.",
  },
  unable_to_link_account: {
    title: "Could not link the account",
    description:
      "Check that you are signed in and try again, or try another account.",
  },
  "email_doesn't_match": {
    title: "Email does not match",
    description:
      "The email of the account that you tried to link does not match your ctxpipe account. Use the same email in both, then try again.",
  },
  invalid_code: {
    title: "Link expired or invalid",
    description: "Start the connection again from Connectors.",
  },
  no_code: {
    title: "Link could not be completed",
    description: "Start the connection again from Connectors.",
  },
  state_mismatch: {
    title: "Session mismatch",
    description:
      "Open Connectors and start the connection again in this browser window.",
  },
  please_restart_the_process: {
    title: "Link request expired",
    description: "Start the connection again from Connectors.",
  },
}

export function oauthErrorMessage(
  error: string,
  errorDescription?: string | null,
): { title: string; description: string } {
  const known = KNOWN[error]
  if (known) {
    if (errorDescription) {
      return { title: known.title, description: errorDescription }
    }
    return known
  }
  return {
    title: "Connection issue",
    description:
      errorDescription?.trim() || `Error: ${error.replace(/_/g, " ")}`,
  }
}
