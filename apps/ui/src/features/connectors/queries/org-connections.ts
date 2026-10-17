import { queryOptions } from "@tanstack/react-query"
import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

export type OrgConnectionListItem = Awaited<
  ReturnType<typeof fetchOrgConnections>
>[number]

export const orgConnectionsKeys = {
  list: (orgSlug: string) => ["org-connections", orgSlug] as const,
}

const TYPE_ORDER: Record<OrgConnectionListItem["type"], number> = {
  github: 0,
  forge: 1,
  linear: 2,
  notion: 3,
  slack: 4,
  pagerduty: 5,
  zendesk: 6,
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

export function orgConnectionsOptions(orgSlug: string) {
  return queryOptions({
    queryKey: orgConnectionsKeys.list(orgSlug),
    queryFn: () => fetchOrgConnections(orgSlug),
  })
}

export async function fetchOrgConnections(orgSlug: string) {
  const res = await client[":orgSlug"].api.v1.connectors.$get({
    param: { orgSlug },
  })
  const json = await readApiJson(res, {
    message: "Failed to load connections",
  })
  return json.items
}
