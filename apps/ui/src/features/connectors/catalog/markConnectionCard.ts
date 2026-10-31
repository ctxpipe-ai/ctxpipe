/**
 * Scrolls to the card of a connection on the Connectors page and marks it
 * for a moment. `ConnectorListItem` sets `data-connection-id` on each card
 * and styles `data-marked`.
 */
export function markConnectionCard(connectionId: string): void {
  const card = document.querySelector<HTMLElement>(
    `[data-connection-id="${CSS.escape(connectionId)}"]`,
  )
  if (!card) return
  card.scrollIntoView({ block: "center" })
  card.dataset.marked = ""
  window.setTimeout(() => {
    delete card.dataset.marked
  }, 2000)
}
