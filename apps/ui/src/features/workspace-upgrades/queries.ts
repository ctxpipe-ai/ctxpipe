import { type QueryClient, queryOptions } from "@tanstack/react-query"
import type { InferResponseType } from "hono/client"
import { type client, getApiClient } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"
import { checkingFormatExpired } from "./checking-format-clock"
import { upgradeIsCheckingFormat } from "./upgrade-copy"

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

/** The hash of the Workspace settings link that lands on the Status group. */
export const WORKSPACE_UPGRADES_HASH = "upgrades"

/**
 * How long to wait before the next read. A run that prepares the pull
 * request changes fast (3 s). A merged pull request that ctxpipe reads changes
 * when the hydrate and the scan end (3 s). An open pull request changes when
 * someone merges it on GitHub (15 s). An item that waits for a click changes when a
 * scan starts it (Always update) or when the user starts it elsewhere (15 s).
 * A re-ingestion that is still blocked for the format, while the Workspace
 * has the new format, waits for the scan after the hydrate (3 s, CTX-944).
 * Nothing else changes by itself: no polling.
 */
export function upgradePollInterval(
  items:
    | readonly (Pick<
        WorkspaceUpgradeItem,
        "key" | "kind" | "status" | "blockedReason" | "targetFormat"
      > &
        Partial<Pick<WorkspaceUpgradeItem, "mergedAt">>)[]
    | undefined,
  formatVersion?: number | null,
  /** `<org>/<workspace>`: names the items for the one-minute limit of the checking state. */
  scope = "",
): number | false {
  const statuses = items?.map((item) => item.status) ?? []
  // A checking state that lasts more than a minute does not keep the poll
  // fast (CTX-949). `map` visits every item, so each one keeps its own clock.
  const checking = (items ?? [])
    .map((item) => {
      const is = upgradeIsCheckingFormat(item, formatVersion)
      const expired = checkingFormatExpired(`${scope}/${item.key}`, is)
      return is && !expired
    })
    .some(Boolean)
  if (
    statuses.some((status) => status === "queued" || status === "running") ||
    items?.some((item) => item.status === "pr_open" && item.mergedAt) ||
    checking
  )
    return 3_000
  if (statuses.includes("pr_open") || statuses.includes("awaiting_operator"))
    return 15_000
  return false
}

/** The refetch interval of the upgrades read: no poll after an error. */
export function upgradesRefetchInterval(query: {
  queryKey?: readonly unknown[]
  state: { status: string; data: WorkspaceUpgrades | undefined }
}): number | false {
  return query.state.status === "error"
    ? false
    : upgradePollInterval(
        query.state.data?.items,
        query.state.data?.formatVersion,
        query.queryKey?.slice(1, 3).join("/"),
      )
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

/** Starts the tip check now: ctxpipe reads the default branch of the Workspace repository. */
async function checkWorkspaceUpgrades(
  orgSlug: string,
  workspaceSlug: string,
): Promise<{ queued: boolean }> {
  const client = await getApiClient()
  const res = await client[":orgSlug"].api.v1.workspaces[
    ":workspaceSlug"
  ].upgrades.check.$post({ param: { orgSlug, workspaceSlug } })
  return readApiJson(res, { message: "Failed to check the upgrade" })
}

type WorkspaceUpgradeMode = "manual" | "automatic"

/**
 * Automatic upgrades on (Always update) or off: ctxpipe commits
 * `upgrades: <mode>` into the format file of the Workspace repository. The
 * reply comes at once with the id of the file job. With `automatic`, the
 * server starts the waiting upgrades when the commit is done, so the browser
 * sends no second request and does not wait for the commit.
 */
export async function saveWorkspaceUpgradeMode(
  orgSlug: string,
  workspaceSlug: string,
  mode: WorkspaceUpgradeMode,
): Promise<{ jobId: string }> {
  const client = await getApiClient()
  return readApiJson(
    await client[":orgSlug"].api.v1.workspaces[
      ":workspaceSlug"
    ].upgrades.automatic.$post({
      param: { orgSlug, workspaceSlug },
      json: { mode },
    }),
    { message: "Failed to save the setting" },
  )
}

/**
 * The automatic-upgrades setting of the Workspace. The server reads it from
 * git on each request, so this read does not poll. Null: ctxpipe has read no
 * tip, or the format file is not valid.
 */
export function workspaceUpgradeModeOptions(
  orgSlug: string,
  workspaceSlug: string,
) {
  return queryOptions({
    queryKey: ["workspace-upgrade-mode", orgSlug, workspaceSlug] as const,
    queryFn: async (): Promise<WorkspaceUpgradeMode | null> => {
      const client = await getApiClient()
      const body = await readApiJson(
        await client[":orgSlug"].api.v1.workspaces[
          ":workspaceSlug"
        ].upgrades.automatic.$get({ param: { orgSlug, workspaceSlug } }),
        { message: "Failed to read the setting" },
      )
      return body.mode
    },
  })
}

/**
 * The file job of the automatic-upgrades setting, read every 2 s until it is done. A job whose
 * run ended with an error comes back `failed` with the cause, so the poll
 * ends. The read is progress only: the server does not need it.
 */
export function automaticUpgradesJobOptions(
  orgSlug: string,
  workspaceSlug: string,
  jobId: string,
) {
  return queryOptions({
    queryKey: ["workspace-upgrades", orgSlug, workspaceSlug, "job", jobId],
    queryFn: async () => {
      const client = await getApiClient()
      return readApiJson(
        await client[":orgSlug"].api.v1.workspaces[":workspaceSlug"].files.jobs[
          ":jobId"
        ].$get({ param: { orgSlug, workspaceSlug, jobId } }),
        { message: "Failed to read the setting" },
      )
    },
    refetchInterval: (query) =>
      query.state.status === "error" ||
      query.state.data?.status === "completed" ||
      query.state.data?.status === "failed"
        ? false
        : 2_000,
  })
}

/**
 * Save the automatic-upgrades setting, and wait for its commit, up to about a
 * minute. It throws the cause when the commit fails. It returns `"pending"`
 * when the commit is not done by then: the server still saves it.
 */
export async function saveWorkspaceUpgradeModeAndWait(
  queryClient: QueryClient,
  orgSlug: string,
  workspaceSlug: string,
  mode: WorkspaceUpgradeMode,
): Promise<"saved" | "pending"> {
  const { jobId } = await saveWorkspaceUpgradeMode(orgSlug, workspaceSlug, mode)
  for (let attempt = 0; attempt < 30; attempt++) {
    const job = await queryClient.fetchQuery({
      ...automaticUpgradesJobOptions(orgSlug, workspaceSlug, jobId),
      staleTime: 0,
    })
    if (job.status === "completed") return "saved"
    if (job.status === "failed")
      throw new Error(
        `ctxpipe could not save the setting. ${job.failureReason ?? "ctxpipe gives no reason."}`,
      )
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  return "pending"
}

/**
 * Check again, and wait for the scan to write its result. The reply of the
 * check comes at once, and the scan runs on the server. This reads the
 * upgrades until the item has a new check time or a new status (the scan
 * ran), up to about a minute. It returns `"pending"` when the scan did not
 * write by then: the page still updates when it does.
 */
export async function checkWorkspaceUpgradesAndWait(
  queryClient: QueryClient,
  orgSlug: string,
  workspaceSlug: string,
  key: string,
): Promise<"checked" | "pending"> {
  const summary = (data: WorkspaceUpgrades | undefined) => {
    const item = data?.items.find((candidate) => candidate.key === key)
    return item ? `${item.status} ${item.checkedAt}` : null
  }
  const before = summary(
    queryClient.getQueryData(workspaceUpgradeKeys.list(orgSlug, workspaceSlug)),
  )
  await checkWorkspaceUpgrades(orgSlug, workspaceSlug)
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) =>
      setTimeout(resolve, attempt === 0 ? 1_500 : 2_000),
    )
    const data = await queryClient.fetchQuery({
      ...workspaceUpgradesOptions(orgSlug, workspaceSlug),
      staleTime: 0,
    })
    if (summary(data) !== before) return "checked"
  }
  return "pending"
}
