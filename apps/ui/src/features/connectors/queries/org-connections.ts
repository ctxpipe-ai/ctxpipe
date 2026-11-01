import { queryOptions } from "@tanstack/react-query"

import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

export type OrgConnectionListItem = Awaited<
  ReturnType<typeof fetchOrgConnections>
>[number]

export const orgConnectionsKeys = {
  list: (orgSlug: string) => ["org-connections", orgSlug] as const,
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
