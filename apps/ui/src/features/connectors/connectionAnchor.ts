/**
 * The connection anchor: the DOM id of the card of a connection on the
 * Connectors page (`ConnectorListItem`).
 */
export function connectionAnchorId(connectionId: string): string {
  return `connection-${connectionId}`
}

/** Scrolls the card of a connection into view. */
export function scrollToConnection(connectionId: string): void {
  document
    .getElementById(connectionAnchorId(connectionId))
    ?.scrollIntoView({ behavior: "smooth", block: "center" })
}
