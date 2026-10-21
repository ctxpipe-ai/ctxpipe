import { queryOptions } from "@tanstack/react-query"
import type { InferResponseType } from "hono/client"
import type { UpgradeProgress } from "@/features/workspace-upgrades/upgrade-progress"
import { type client, getApiClient } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

type WorkspaceIngestionResponse = InferResponseType<
  (typeof client)[":orgSlug"]["api"]["v1"]["workspaces"][":workspaceSlug"]["ingestion"]["$get"],
  200
>

/** One unit of ingestion work that runs now for a Workspace (CTX-959). */
export type IngestionItem = WorkspaceIngestionResponse["items"][number]

/** The Workspaces of the org that ingest now, each with its items. */
type OrgIngestion = Array<{
  workspaceSlug: string
  items: IngestionItem[]
}>

const ingestionKeys = {
  org: (orgSlug: string) => ["workspace-ingestion", orgSlug] as const,
  workspace: (orgSlug: string, workspaceSlug: string) =>
    ["workspace-ingestion", orgSlug, workspaceSlug] as const,
}

/**
 * The poll interval: fast while work runs, so the progress moves; slow when
 * the Workspace is idle, so a new run shows in a minute or less.
 */
function ingestionPollInterval(active: boolean, activeMs: number) {
  return active ? activeMs : 60_000
}

/** One read for the sidebar: every Workspace of the org that ingests now. */
export function orgIngestionOptions(orgSlug: string) {
  return queryOptions({
    queryKey: ingestionKeys.org(orgSlug),
    queryFn: async (): Promise<OrgIngestion> => {
      const api = await getApiClient()
      const res = await api[":orgSlug"].api.v1["workspace-ingestion"].$get({
        param: { orgSlug },
      })
      const body = await readApiJson(res, {
        message: "Failed to load the ingestion state",
      })
      return body.workspaces
    },
    refetchInterval: (query) =>
      ingestionPollInterval(Boolean(query.state.data?.length), 5_000),
  })
}

/** The ingestion work of one Workspace, for Workspace settings. */
export function workspaceIngestionOptions(
  orgSlug: string,
  workspaceSlug: string,
) {
  return queryOptions({
    queryKey: ingestionKeys.workspace(orgSlug, workspaceSlug),
    queryFn: async (): Promise<IngestionItem[]> => {
      const api = await getApiClient()
      const res = await api[":orgSlug"].api.v1.workspaces[
        ":workspaceSlug"
      ].ingestion.$get({ param: { orgSlug, workspaceSlug } })
      const body = await readApiJson(res, {
        message: "Failed to load the ingestion state",
      })
      return body.items
    },
    refetchInterval: (query) =>
      ingestionPollInterval(Boolean(query.state.data?.length), 3_000),
  })
}

/**
 * The sidebar text for the work of a Workspace, for example "Ingesting 2
 * sources". A hydrate is not a source, so alone it has its own text.
 */
export function ingestingLabel(items: readonly IngestionItem[]): string | null {
  if (!items.length) return null
  const sources = items.filter((item) => item.kind !== "hydrate").length
  if (!sources) return "Indexing the newest commit"
  return `Ingesting ${sources} ${sources === 1 ? "source" : "sources"}`
}

const STAGE_LABELS: Record<IngestionItem["stage"], string> = {
  queued: "Queued. ctxpipe starts the run in a moment.",
  waiting: "Waiting for an earlier run of this repository",
  planning: "Planning the run",
  indexing: "Indexing the code for search",
  ingesting: "Reading the code",
  publishing: "Publishing the knowledge files",
  syncing: "Syncing the sources",
  reingesting: "Re-ingesting the sources",
  hydrating: "Indexing the newest commit…",
}

/** The title of an item in the "Ingesting now" list. */
export function ingestionItemTitle(item: IngestionItem): string {
  switch (item.kind) {
    case "repository":
      return item.name
    case "source_sync":
      return `${item.name} sources`
    case "reingest":
      return "Upgrade re-ingestion"
    case "hydrate":
      return "Newest commit"
  }
}

/** The progress of an item, in the shape of the upgrade progress (PR #443). */
export function ingestionProgress(item: IngestionItem): UpgradeProgress {
  const { progress } = item
  const unit =
    progress?.unit === "repositories"
      ? progress.total === 1
        ? "repository"
        : "repositories"
      : progress?.total === 1
        ? "part"
        : "parts"
  return {
    label: STAGE_LABELS[item.stage],
    count: progress
      ? `${progress.done} of ${progress.total} ${unit} done`
      : null,
    // A waiting run has done nothing yet: an empty bar, not a pulse.
    fraction: progress
      ? progress.total
        ? progress.done / progress.total
        : 0
      : item.stage === "waiting" || item.stage === "queued"
        ? 0
        : null,
    detail:
      item.stage === "waiting"
        ? "Two runs of one repository do not publish at the same time. This run starts when the earlier run ends."
        : null,
    since: item.startedAt,
  }
}
