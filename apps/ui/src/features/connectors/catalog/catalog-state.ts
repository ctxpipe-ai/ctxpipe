import type { ConnectorHealth } from "../connectorHealth"
import type { OrgConnectionListItem } from "../queries/org-connections"
import {
  CONNECTOR_GROUPS,
  type AvailableConnectorEntry,
  CONNECTOR_REGISTRY,
  type ConnectorEntry,
  type ConnectorGroupId,
} from "./registry"

type ConnectionStatus = OrgConnectionListItem["status"]

/**
 * One catalog row: a registry entry with one state for its provider.
 * `status` is the worst state of its connections; `fixConnectionId` is the
 * first connection in that state when the state needs a fix.
 */
export type CatalogRow =
  | {
      kind: "coming_soon"
      entry: Extract<ConnectorEntry, { availability: "coming_soon" }>
    }
  | {
      kind: "available"
      entry: AvailableConnectorEntry
      count: number
      status: ConnectionStatus | null
      fixConnectionId: string | null
    }

export type CatalogViewId =
  | "all"
  | "connected"
  | ConnectorGroupId
  | "coming_soon"

/** The worst state first. */
const STATUS_ORDER: readonly ConnectionStatus[] = [
  "needs_reconnect",
  "setup_pending",
  "connected",
]

function catalogRow(
  entry: ConnectorEntry,
  connections: readonly OrgConnectionListItem[],
): CatalogRow {
  switch (entry.availability) {
    case "coming_soon":
      return { kind: "coming_soon", entry }
    case "available": {
      const own = connections.filter((row) => row.type === entry.id)
      const status =
        STATUS_ORDER.find((candidate) =>
          own.some((row) => row.status === candidate),
        ) ?? null
      const fix =
        status === "connected"
          ? undefined
          : own.find((row) => row.status === status)
      return {
        kind: "available",
        entry,
        count: own.length,
        status,
        fixConnectionId: fix?.id ?? null,
      }
    }
    default: {
      const unhandled: never = entry
      return unhandled
    }
  }
}

/** Each registry entry with the state of its provider. */
export function catalogRows(
  connections: readonly OrgConnectionListItem[],
): CatalogRow[] {
  return CONNECTOR_REGISTRY.map((entry) => catalogRow(entry, connections))
}

/**
 * The card health that shows the state of a provider, so that the catalog
 * and the Connectors page cards show a state the same way. The count is new:
 * "2 connected". Null for a provider with no connection.
 */
export function statusChip(
  row: Extract<CatalogRow, { kind: "available" }>,
): { health: ConnectorHealth; label?: string } | null {
  switch (row.status) {
    case "needs_reconnect":
      return { health: "reconnect" }
    case "setup_pending":
      return { health: "setup_pending" }
    case "connected":
      return row.count > 1
        ? { health: "connected", label: `${row.count} connected` }
        : { health: "connected" }
    case null:
      return null
  }
}

export function groupName(id: ConnectorGroupId): string {
  return CONNECTOR_GROUPS.find((group) => group.id === id)?.name ?? ""
}

function inView(row: CatalogRow, view: CatalogViewId): boolean {
  switch (view) {
    case "all":
      return true
    case "connected":
      return row.kind === "available" && row.count > 0
    case "coming_soon":
      return row.kind === "coming_soon"
    default:
      return row.entry.group === view
  }
}

/** The views of the left pane, with the number of rows in each. */
export function catalogViews(
  rows: readonly CatalogRow[],
): { id: CatalogViewId; name: string; count: number }[] {
  const views: { id: CatalogViewId; name: string }[] = [
    { id: "all", name: "All" },
    { id: "connected", name: "Connected" },
    ...CONNECTOR_GROUPS,
    { id: "coming_soon", name: "Coming soon" },
  ]
  return views.map((view) => ({
    ...view,
    count: rows.filter((row) => inView(row, view.id)).length,
  }))
}

/**
 * The rows of a view. A search looks in every view: it matches the name,
 * the description, or the group name.
 */
export function rowsInView(
  rows: readonly CatalogRow[],
  view: CatalogViewId,
  query: string,
): CatalogRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows.filter((row) => inView(row, view))
  return rows.filter(({ entry }) =>
    [entry.name, entry.description, groupName(entry.group)].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  )
}

/**
 * The catalog order (`CONNECTOR_REGISTRY`): GitHub first, because every other
 * connector syncs through it. Then `createdAt`.
 */
export function sortOrgConnectionsForDisplay(
  items: readonly OrgConnectionListItem[],
): OrgConnectionListItem[] {
  const order = (type: OrgConnectionListItem["type"]) =>
    CONNECTOR_REGISTRY.findIndex((entry) => entry.id === type)
  return [...items].sort((a, b) => {
    const byType = order(a.type) - order(b.type)
    if (byType !== 0) return byType
    return a.createdAt.localeCompare(b.createdAt)
  })
}
