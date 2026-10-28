type SetupStatus = {
  status: "pending" | "installed" | "revoked"
  oauthClientConfigured: boolean
  /** The identifier of the local client saved on the connection. */
  oauthClientId: string | null
  deploymentOAuthClient: boolean
  webhookConfigured: boolean
}

/** A local OAuth client is in use, or is needed: the user can register one. */
export function zendeskUsesLocalClient(
  status: Pick<SetupStatus, "oauthClientId" | "deploymentOAuthClient">,
): boolean {
  return status.oauthClientId !== null || !status.deploymentOAuthClient
}

/**
 * A connection holds auth only (ADR-050, ADR-058). Hosted ctxpipe has a
 * global OAuth client; a self-hosted deployment registers its own first.
 */
export function getZendeskSetupSteps(deploymentOAuthClient: boolean) {
  return [
    { id: "account", label: "Zendesk account" },
    ...(deploymentOAuthClient
      ? []
      : [{ id: "register", label: "Register an OAuth client" }]),
    { id: "connect", label: "Connect Zendesk" },
    { id: "workspaces", label: "Add to Workspaces" },
  ] as const
}

type ZendeskSetupStep =
  | "account"
  | "register"
  | "connect"
  | "workspaces"
  | "done"

export function getZendeskSetupStep(
  status: SetupStatus | undefined,
  progress: {
    workspacesDone: boolean
    /** The admin opened setup to authorize again, to add the webhook. */
    reconnect: boolean
    /** The user opened the OAuth client step to change the saved client. */
    changingClient: boolean
  },
): ZendeskSetupStep {
  if (!status) return "account"
  if (progress.changingClient) return "register"
  if (status.status !== "installed")
    return status.oauthClientConfigured ? "connect" : "register"
  if (progress.reconnect) return "connect"
  return progress.workspacesDone ? "done" : "workspaces"
}

/**
 * The card action. Zendesk lets only an admin add the webhook, so a
 * connection without it can authorize again as an admin. As on the other
 * cards, Manage opens the Workspaces step once the connection is complete.
 */
export function getZendeskCardCtaLabel(status: SetupStatus): string | null {
  if (status.status === "revoked") return "Reconnect Zendesk"
  if (status.status === "pending") return "Connect Zendesk"
  return status.webhookConfigured ? "Manage" : "Add the webhook"
}
