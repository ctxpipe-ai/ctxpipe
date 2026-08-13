export type ConnectorHealth =
  | "checking"
  | "not_connected"
  | "connected"
  | "error"

export function connectorHealthLabel(health: ConnectorHealth): string {
  switch (health) {
    case "checking":
      return "Checking"
    case "not_connected":
      return "Not yet connected"
    case "connected":
      return "Connected"
    case "error":
      return "Error"
  }
}

export function formatSelectedItemCount(count: number): string {
  return `${count} selected item${count === 1 ? "" : "s"}`
}

export function isFailedSetupPhase(setupPhase: string): boolean {
  return setupPhase === "sync_failed" || setupPhase === "config_failed"
}
