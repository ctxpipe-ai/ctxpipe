import { queryOptions, useQuery } from "@tanstack/react-query"
import { getApiClient } from "@/lib/api"
import { pollWhileOk, readApiJson } from "@/lib/api-result"
import { authClient } from "@/lib/auth-client"
import { isAdminRole } from "@/lib/session-user"

export type UpgradeStatus =
  | "awaiting_operator"
  | "queued"
  | "running"
  | "pr_open"
  | "completed"
  | "failed"
  | "blocked"

/** One upgrade item. The shape follows `GET /workspaces/{slug}/upgrades`. */
export type WorkspaceUpgradeItem = {
  key: string
  kind: "format"
  title: string
  status: UpgradeStatus
  fromFormat: number
  targetFormat: number
  steps: Array<{
    format: number
    title: string
    commitSha: string | null
    report: string[]
  }>
  pullRequest: { number: number | null; url: string } | null
  blockedReason: "write_access" | null
  note: string | null
  failureReason: string | null
  approvedBy: string | null
  approvedAt: string | null
  updatedAt: string
}

export type WorkspaceUpgrades = {
  /** `null`: not read yet. `-1`: the format file is not valid. */
  formatVersion: number | null
  codeFormat: number
  items: WorkspaceUpgradeItem[]
}

type UpgradeParams = { orgSlug: string; workspaceSlug: string }

/**
 * The upgrade routes as the Hono client calls them. The backend route type
 * does not reach the client type yet, so this type stands in for it.
 */
type UpgradeRoutes = {
  upgrades: {
    $get(args: { param: UpgradeParams }): Promise<Response>
    [":key"]: {
      start: {
        $post(args: {
          param: UpgradeParams & { key: string }
        }): Promise<Response>
      }
    }
  }
}

async function upgradeRoutes() {
  const client = await getApiClient()
  return client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ] as unknown as UpgradeRoutes
}

export const workspaceUpgradeKeys = {
  list: (orgSlug: string, workspaceSlug: string) =>
    ["workspace-upgrades", orgSlug, workspaceSlug] as const,
}

/** A run is in progress: ctx| prepares the pull request. */
export function upgradeIsRunning(item: WorkspaceUpgradeItem): boolean {
  return item.status === "queued" || item.status === "running"
}

export function workspaceUpgradesOptions(
  orgSlug: string,
  workspaceSlug: string,
) {
  return queryOptions({
    queryKey: workspaceUpgradeKeys.list(orgSlug, workspaceSlug),
    queryFn: async (): Promise<WorkspaceUpgrades> => {
      const routes = await upgradeRoutes()
      const res = await routes.upgrades.$get({
        param: { orgSlug, workspaceSlug },
      })
      return readApiJson<WorkspaceUpgrades>(res, {
        message: "Failed to load the upgrades",
      })
    },
    // Poll while a run prepares the pull request. A merge on GitHub happens
    // in another tab, so a focus read also shows the new state.
    refetchInterval: (query) =>
      query.state.data?.items.some(upgradeIsRunning)
        ? pollWhileOk(3_000)(query)
        : false,
  })
}

export async function startWorkspaceUpgrade(
  orgSlug: string,
  workspaceSlug: string,
  key: string,
): Promise<WorkspaceUpgradeItem> {
  const routes = await upgradeRoutes()
  const res = await routes.upgrades[":key"].start.$post({
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
  const roleQuery = useQuery({
    queryKey: ["organization-member-role", orgSlug],
    queryFn: () =>
      authClient.organization.getActiveMemberRole({
        query: { organizationSlug: orgSlug },
        fetchOptions: { throw: true },
      }),
  })
  return roleQuery.isSuccess ? isAdminRole(roleQuery.data?.role) : null
}
