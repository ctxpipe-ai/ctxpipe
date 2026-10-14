type SetupStatus = {
  status: "pending" | "installed" | "revoked"
  oauthClientConfigured: boolean
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
  progress: { workspacesDone: boolean },
): ZendeskSetupStep {
  if (!status) return "account"
  if (status.status !== "installed")
    return status.oauthClientConfigured ? "connect" : "register"
  return progress.workspacesDone ? "done" : "workspaces"
}

/** The card action, or null when the connection works. */
export function getZendeskCardCtaLabel(status: SetupStatus): string | null {
  return status.status === "revoked" ? "Reconnect Zendesk" : null
}
