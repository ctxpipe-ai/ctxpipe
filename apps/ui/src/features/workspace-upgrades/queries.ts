import { queryOptions } from "@tanstack/react-query"
import type { InferResponseType } from "hono/client"
import { type client, getApiClient } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"
import { useOrgMemberRole } from "@/lib/org-member-role"
import { isAdminRole } from "@/lib/session-user"

type UpgradesResponse = InferResponseType<
  (typeof client)[":orgSlug"]["api"]["v1"]["workspaces"][":workspaceSlug"]["upgrades"]["$get"],
  200
>

/**
 * One upgrade item, as `GET /workspaces/{slug}/upgrades` returns it. A
 * re-ingestion item can carry an `estimate` text (CTX-746).
 */
export type WorkspaceUpgradeItem = UpgradesResponse["items"][number] & {
  estimate?: string | null
}

export type UpgradeStatus = WorkspaceUpgradeItem["status"]

export type WorkspaceUpgrades = Omit<UpgradesResponse, "items"> & {
  items: WorkspaceUpgradeItem[]
}

export const workspaceUpgradeKeys = {
  list: (orgSlug: string, workspaceSlug: string) =>
    ["workspace-upgrades", orgSlug, workspaceSlug] as const,
}

/**
 * How long to wait before the next read. A run that prepares the pull
 * request changes fast (3 s). An open pull request changes when someone
 * merges it on GitHub (15 s). Nothing else changes by itself: no polling.
 */
export function upgradePollInterval(
  data: WorkspaceUpgrades | undefined,
): number | false {
  const statuses = data?.items.map((item) => item.status) ?? []
  if (statuses.some((status) => status === "queued" || status === "running"))
    return 3_000
  if (statuses.includes("pr_open")) return 15_000
  return false
}

export function workspaceUpgradesOptions(
  orgSlug: string,
  workspaceSlug: string,
) {
  return queryOptions({
    queryKey: workspaceUpgradeKeys.list(orgSlug, workspaceSlug),
    queryFn: async (): Promise<WorkspaceUpgrades> => {
      const client = await getApiClient()
      const res = await client[":orgSlug"].api.v1.workspaces[
        ":workspaceSlug"
      ].upgrades.$get({ param: { orgSlug, workspaceSlug } })
      return readApiJson<WorkspaceUpgrades>(res, {
        message: "Failed to load the upgrades",
      })
    },
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.status === "error"
        ? false
        : upgradePollInterval(query.state.data),
  })
}

export async function startWorkspaceUpgrade(
  orgSlug: string,
  workspaceSlug: string,
  key: string,
): Promise<WorkspaceUpgradeItem> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].upgrades[":key"].start.$post({
    param: { orgSlug, workspaceSlug, key },
  })
  return readApiJson<WorkspaceUpgradeItem>(res, {
    message: "Failed to start the upgrade",
  })
}

/**
 * Whether the user is an owner or admin of the org. `null` while the role
 * loads or when it fails: no button shows then, so a member never sees a
 * Start button for a moment.
 */
export function useIsOrgAdmin(orgSlug: string): boolean | null {
  const roleQuery = useOrgMemberRole(orgSlug)
  return roleQuery.isSuccess ? isAdminRole(roleQuery.data?.role) : null
}
