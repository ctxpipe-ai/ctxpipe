type SetupStatus = {
  status: "pending" | "installed" | "revoked"
  oauthClientConfigured: boolean
  webhookConfigured: boolean
}

/**
 * A connection holds auth only (ADR-050, ADR-054). Hosted ctx| has a
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

export type ZendeskSetupStep =
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
  },
): ZendeskSetupStep {
  if (!status) return "account"
  if (status.status !== "installed")
    return status.oauthClientConfigured ? "connect" : "register"
  if (progress.reconnect) return "connect"
  return progress.workspacesDone ? "done" : "workspaces"
}

/**
 * The card action, or null. Zendesk lets only an admin add the webhook,
 * so a connection without it can authorize again as an admin.
 */
export function getZendeskCardCtaLabel(status: SetupStatus): string | null {
  if (status.status === "revoked") return "Reconnect Zendesk"
  return status.status === "installed" && !status.webhookConfigured
    ? "Add the webhook"
    : null
}
