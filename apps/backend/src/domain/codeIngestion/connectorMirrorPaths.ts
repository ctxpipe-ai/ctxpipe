/** Top-level context-repo prefixes written by git-native connectors. */
export const CONNECTOR_MIRROR_ROOTS = [
  "github",
  "linear",
  "notion",
  "slack",
  "confluence",
  "pagerduty",
  "plain",
] as const

type ConnectorMirrorRoot = (typeof CONNECTOR_MIRROR_ROOTS)[number]

/** The connector root of a warehouse path (`linear/…` → `linear`), else null. */
export function connectorMirrorRoot(path: string): ConnectorMirrorRoot | null {
  const normalized = path.replace(/\\/g, "/")
  return (
    CONNECTOR_MIRROR_ROOTS.find(
      (root) => normalized === root || normalized.startsWith(`${root}/`),
    ) ?? null
  )
}

/** True for connector warehouse paths (`linear/…`, `github/pulls/…`, …). */
export function isConnectorMirrorPath(path: string): boolean {
  return connectorMirrorRoot(path) !== null
}
