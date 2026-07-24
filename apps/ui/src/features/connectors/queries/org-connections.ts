export type OrgConnectionListItem = {
  id: string
  type: "github" | "forge" | "notion"
  createdAt: string
  updatedAt: string
}

/** Refetch connector data on this interval while the org connectors page is open. */
export const CONNECTORS_PAGE_POLL_INTERVAL_MS = 3000

export const orgConnectionsKeys = {
  list: (orgSlug: string) => ["org-connections", orgSlug] as const,
}

export async function fetchOrgConnections(
  orgSlug: string,
): Promise<OrgConnectionListItem[]> {
  const res = await fetch(`/${orgSlug}/api/v1/connectors`, {
    credentials: "include",
  })
  if (!res.ok) throw new Error("Failed to load connections")
  const json = (await res.json()) as { items: OrgConnectionListItem[] }
  return json.items
}
