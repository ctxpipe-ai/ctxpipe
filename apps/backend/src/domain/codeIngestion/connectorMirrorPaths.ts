/** Top-level context-repo prefixes written by git-native connectors. */
export const CONNECTOR_MIRROR_ROOTS = [
  "github",
  "linear",
  "notion",
  "slack",
  "confluence",
] as const

/** True for connector warehouse paths (`linear/…`, `github/pulls/…`, …). */
export function isConnectorMirrorPath(path: string): boolean {
  const normalised = path.replace(/\\/g, "/")
  return CONNECTOR_MIRROR_ROOTS.some(
    (root) => normalised === root || normalised.startsWith(`${root}/`),
  )
}
