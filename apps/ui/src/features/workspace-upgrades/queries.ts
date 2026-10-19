import { queryOptions } from "@tanstack/react-query"
import type { InferResponseType } from "hono/client"
import { type client, getApiClient } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

type UpgradesResponse = InferResponseType<
  (typeof client)[":orgSlug"]["api"]["v1"]["workspaces"][":workspaceSlug"]["upgrades"]["$get"],
  200
>

/**
 * One upgrade item, as `GET /workspaces/{slug}/upgrades` returns it. A
 * re-ingestion item carries its cost and time `estimate` (CTX-746).
 */
export type WorkspaceUpgradeItem = UpgradesResponse["items"][number]

export type UpgradeStatus = WorkspaceUpgradeItem["status"]

export type WorkspaceUpgrades = Omit<UpgradesResponse, "items"> & {
  items: WorkspaceUpgradeItem[]
}

export const workspaceUpgradeKeys = {
  list: (orgSlug: string, workspaceSlug: string) =>
    ["workspace-upgrades", orgSlug, workspaceSlug] as const,
  pending: (orgSlug: string) =>
    ["workspace-upgrades", orgSlug, { pending: true }] as const,
}

type PendingUpgradesResponse = InferResponseType<
  (typeof client)[":orgSlug"]["api"]["v1"]["workspace-upgrades"]["pending"]["$get"],
  200
>

/** The pending upgrades of the org, one entry for each Workspace that has one. */
type PendingWorkspaceUpgrades = PendingUpgradesResponse["workspaces"]

/** The hash of the Workspace settings link that lands on the Upgrades group. */
export const WORKSPACE_UPGRADES_HASH = "upgrades"

/**
 * How long to wait before the next read. A run that prepares the pull
 * request changes fast (3 s). An open pull request changes when someone
 * merges it on GitHub (15 s). Nothing else changes by itself: no polling.
 */
export function upgradePollInterval(
  items: readonly Pick<WorkspaceUpgradeItem, "status">[] | undefined,
): number | false {
  const statuses = items?.map((item) => item.status) ?? []
  if (statuses.some((status) => status === "queued" || status === "running"))
    return 3_000
  if (statuses.includes("pr_open")) return 15_000
  return false
}

/** The refetch interval of the upgrades read: no poll after an error. */
export function upgradesRefetchInterval(query: {
  state: { status: string; data: WorkspaceUpgrades | undefined }
}): number | false {
  return query.state.status === "error"
    ? false
    : upgradePollInterval(query.state.data?.items)
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
      return readApiJson(res, {
        message: "Failed to load the upgrades",
      })
    },
    staleTime: 0,
    refetchInterval: upgradesRefetchInterval,
  })
}

/**
 * One read of the pending upgrades of all the Workspaces of the org, for the
 * home alert. The read writes nothing on the server.
 */
export function pendingWorkspaceUpgradesOptions(orgSlug: string) {
  return queryOptions({
    queryKey: workspaceUpgradeKeys.pending(orgSlug),
    queryFn: async (): Promise<PendingWorkspaceUpgrades> => {
      const client = await getApiClient()
      const res = await client[":orgSlug"].api.v1[
        "workspace-upgrades"
      ].pending.$get({ param: { orgSlug } })
      const body = await readApiJson(res, {
        message: "Failed to load the upgrades",
      })
      return body.workspaces
    },
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.status === "error"
        ? false
        : upgradePollInterval(
            query.state.data?.flatMap((workspace) => workspace.items),
          ),
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
  return readApiJson(res, {
    message: "Failed to start the upgrade",
  })
}

/** Starts the tip check now: ctx| reads the default branch of the Workspace repository. */
export async function checkWorkspaceUpgrades(
  orgSlug: string,
  workspaceSlug: string,
): Promise<{ queued: boolean }> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].upgrades.check.$post({ param: { orgSlug, workspaceSlug } })
  return readApiJson(res, { message: "Failed to check the upgrade" })
}

/**
 * Always update: ctx| commits `upgrades: automatic` into the format file of
 * the Workspace repository. This waits until the commit is on the default
 * branch, so that the pull request of the next start contains the setting.
 */
export async function enableAutomaticWorkspaceUpgrades(
  orgSlug: string,
  workspaceSlug: string,
): Promise<void> {
  const client = await getApiClient()
  const workspace = client[":orgSlug"].api.v1.workspaces[":workspaceSlug"]
  const { jobId } = await readApiJson(
    await workspace.upgrades.automatic.$post({
      param: { orgSlug, workspaceSlug },
    }),
    { message: "Failed to save the setting" },
  )
  // A commit takes a few seconds. Stop after about two minutes.
  for (let attempt = 0; attempt < 120; attempt++) {
    const job = await readApiJson(
      await workspace.files.jobs[":jobId"].$get({
        param: { orgSlug, workspaceSlug, jobId },
      }),
      { message: "Failed to save the setting" },
    )
    if (job.status === "completed") return
    if (job.status === "failed")
      throw new Error(job.failureReason ?? "ctx| could not save the setting.")
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(
    "ctx| is still saving the setting. Start the upgrade in Workspace settings.",
  )
}
