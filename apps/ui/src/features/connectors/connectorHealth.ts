export type ConnectorHealth =
  | "checking"
  | "setup_pending"
  | "awaiting_merge"
  | "reconnect"
  | "syncing"
  | "connected"
  | "couldnt_load"
  | "sync_failed"
  | "config_failed"

export function connectorHealthLabel(health: ConnectorHealth): string {
  switch (health) {
    case "checking":
      return "Checking"
    case "setup_pending":
      return "Setup not finished"
    case "awaiting_merge":
      return "Awaiting merge"
    case "reconnect":
      return "Needs reconnect"
    case "syncing":
      return "Syncing"
    case "connected":
      return "Connected"
    case "couldnt_load":
      return "Couldn't load"
    case "sync_failed":
      return "Sync failed"
    case "config_failed":
      return "Config PR failed"
  }
}

/**
 * `draft` comes from the server: the row never finished setup. A row that is
 * not a draft and not connected (revoked, uninstalled, or not linked for this
 * member) needs a reconnect, not a new setup. A revoked or uninstalled row
 * needs a reconnect in every phase.
 */
export function resolveConnectorHealth(input: {
  statusError: boolean
  checking: boolean
  installationStatus?: string | null
  setupPhase?: string
  connected: boolean
  draft: boolean
}): ConnectorHealth {
  if (input.statusError) return "couldnt_load"
  if (input.checking) return "checking"
  if (
    input.installationStatus === "revoked" ||
    input.installationStatus === "uninstalled"
  ) {
    return "reconnect"
  }
  if (input.setupPhase === "sync_failed") return "sync_failed"
  if (input.setupPhase === "config_failed") return "config_failed"
  if (input.setupPhase === "initial_sync") return "syncing"
  if (input.connected) return "connected"
  if (input.draft) return "setup_pending"
  if (input.setupPhase === "awaiting_merge") return "awaiting_merge"
  return "reconnect"
}
