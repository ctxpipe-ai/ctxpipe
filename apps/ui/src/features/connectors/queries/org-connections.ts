export type OrgConnectionListItem = {
  id: string
  type: "github" | "forge"
  createdAt: string
  updatedAt: string
}

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
