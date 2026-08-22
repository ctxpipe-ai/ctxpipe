import { apiFetch, readApiJson } from "@/lib/api-result"

export type OrgConnectionListItem = {
  id: string
  type: "github" | "forge" | "slack" | "linear" | "notion"
  createdAt: string
  updatedAt: string
}

export const orgConnectionsKeys = {
  list: (orgSlug: string) => ["org-connections", orgSlug] as const,
}

const TYPE_ORDER: Record<OrgConnectionListItem["type"], number> = {
  github: 0,
  forge: 1,
  linear: 2,
  notion: 3,
}

/** GitHub first — every other connector syncs through it. Then createdAt. */
export function sortOrgConnectionsForDisplay(
  items: readonly OrgConnectionListItem[],
): OrgConnectionListItem[] {
  return [...items].sort((a, b) => {
    const byType = TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
    if (byType !== 0) return byType
    return a.createdAt.localeCompare(b.createdAt)
  })
}

export async function fetchOrgConnections(
  orgSlug: string,
): Promise<OrgConnectionListItem[]> {
  const res = await apiFetch(`/${orgSlug}/api/v1/connectors`, {
    credentials: "include",
  })
  const json = await readApiJson<{ items: OrgConnectionListItem[] }>(res, {
    message: "Failed to load connections",
  })
  return json.items
}
