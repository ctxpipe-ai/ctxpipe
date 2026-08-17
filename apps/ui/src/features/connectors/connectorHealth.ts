export type ConnectorHealth =
  | "checking"
  | "not_connected"
  | "connected"
  | "couldnt_load"
  | "sync_failed"
  | "config_failed"

export function connectorHealthLabel(health: ConnectorHealth): string {
  switch (health) {
    case "checking":
      return "Checking"
    case "not_connected":
      return "Not yet connected"
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

export function formatSelectedItemCount(count: number): string {
  return `${count} selected item${count === 1 ? "" : "s"}`
}

export function resolveConnectorHealth(input: {
  statusError: boolean
  checking: boolean
  setupPhase?: string
  connected: boolean
}): ConnectorHealth {
  if (input.statusError) return "couldnt_load"
  if (input.checking) return "checking"
  if (input.setupPhase === "sync_failed") return "sync_failed"
  if (input.setupPhase === "config_failed") return "config_failed"
  return input.connected ? "connected" : "not_connected"
}
