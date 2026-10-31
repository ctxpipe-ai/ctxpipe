import type { OrgConnectionListItem } from "../queries/org-connections"
import {
  CONNECTOR_GROUPS,
  CONNECTOR_REGISTRY,
  type ConnectorEntry,
  type ConnectorGroupId,
} from "./registry"

type ConnectionStatus = OrgConnectionListItem["status"]

/**
 * One state for each provider. `status` is the worst state of its
 * connections; `fixConnectionId` is the first connection in that state when
 * the state needs a fix.
 */
export type ProviderState =
  | { kind: "coming_soon" }
  | {
      kind: "available"
      count: number
      status: ConnectionStatus | null
      fixConnectionId: string | null
    }

export type CatalogRow = { entry: ConnectorEntry; state: ProviderState }

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

function providerState(
  entry: ConnectorEntry,
  connections: readonly OrgConnectionListItem[],
): ProviderState {
  if (entry.availability === "coming_soon") return { kind: "coming_soon" }
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
    count: own.length,
    status,
    fixConnectionId: fix?.id ?? null,
  }
}

/** Each registry entry with the state of its provider. */
export function catalogRows(
  connections: readonly OrgConnectionListItem[],
): CatalogRow[] {
  return CONNECTOR_REGISTRY.map((entry) => ({
    entry,
    state: providerState(entry, connections),
  }))
}

/** The status word of a row. Null for a provider with no connection. */
export function statusLabel(state: ProviderState): string | null {
  if (state.kind === "coming_soon") return "Coming soon"
  switch (state.status) {
    case "needs_reconnect":
      return "Needs reconnect"
    case "setup_pending":
      return "Setup not finished"
    case "connected":
      return state.count > 1 ? `${state.count} connected` : "Connected"
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
      return row.state.kind === "available" && row.state.count > 0
    case "coming_soon":
      return row.state.kind === "coming_soon"
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
