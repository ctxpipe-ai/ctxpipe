const KNOWN: Record<string, { title: string; description: string }> = {
  account_already_linked_to_different_user: {
    title: "Atlassian is linked to another profile",
    description:
      "This Atlassian account is already connected to a different user in ctx pipe. You can try linking from the other profile (User account → Unlink Atlassian).",
  },
  unable_to_link_account: {
    title: "Could not link Atlassian",
    description: "Check that you are signed in and try again, or try another account.",
  },
  "email_doesn't_match": {
    title: "Email does not match",
    description:
      "The email on the Atlassian account does not match your account settings. Use “allow different emails” in link settings, or add the same email in Atlassian or your user profile first.",
  },
  invalid_code: {
    title: "Link expired or invalid",
    description: "Start the “Connect Atlassian” flow again from Connectors.",
  },
  no_code: {
    title: "Link could not be completed",
    description: "Try the Atlassian sign-in and link again from Connectors.",
  },
  state_mismatch: {
    title: "Session mismatch",
    description: "Open Connectors and start “Connect Atlassian” again in this browser window.",
  },
  please_restart_the_process: {
    title: "Link request expired",
    description: "Start the Atlassian link again from Connectors.",
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
    description: errorDescription?.trim() || `Error: ${error.replace(/_/g, " ")}`,
  }
}
