import { queryOptions, useQuery } from "@tanstack/react-query"
import type { InferResponseType } from "hono/client"

import type { UpgradeProgress } from "@/features/workspace-upgrades/upgrade-progress"
import { type client, getApiClient } from "@/lib/api"
import { pollWhileOk, readApiJson } from "@/lib/api-result"

type OrgIngestionResponse = InferResponseType<
  (typeof client)[":orgSlug"]["api"]["v1"]["workspace-ingestion"]["$get"],
  200
>

type WorkspaceIngestionResponse = InferResponseType<
  (typeof client)[":orgSlug"]["api"]["v1"]["workspaces"][":workspaceSlug"]["ingestion"]["$get"],
  200
>

/** One unit of ingestion work that runs now for a Workspace (CTX-959). */
export type IngestionItem = WorkspaceIngestionResponse["items"][number]

/** A Workspace of the org that ingests now, with the count of its work. */
type WorkspaceIngestionCount = OrgIngestionResponse["workspaces"][number]

const ingestionKeys = {
  org: (orgSlug: string) => ["workspace-ingestion", orgSlug] as const,
  workspace: (orgSlug: string, workspaceSlug: string) =>
    ["workspace-ingestion", orgSlug, workspaceSlug] as const,
}

/**
 * The poll interval: fast while work runs, so the progress moves; slow when
 * the Workspace is idle, so a new run shows in a minute or less. A failed
 * read stops the poll.
 */
function ingestionPollInterval(query: {
  state: { status: string; data?: readonly unknown[] }
}) {
  return pollWhileOk(query.state.data?.length ? 5_000 : 60_000)(query)
}

/** One read for the sidebar: every Workspace of the org that ingests now. */
function orgIngestionOptions(orgSlug: string) {
  return queryOptions({
    queryKey: ingestionKeys.org(orgSlug),
    queryFn: async (): Promise<WorkspaceIngestionCount[]> => {
      const api = await getApiClient()
      const res = await api[":orgSlug"].api.v1["workspace-ingestion"].$get({
        param: { orgSlug },
      })
      const body = await readApiJson(res, {
        message: "Failed to load the ingestion state",
      })
      return body.workspaces
    },
    refetchInterval: ingestionPollInterval,
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
    refetchInterval: ingestionPollInterval,
  })
}

/**
 * The sidebar text for the work of a Workspace, for example "Ingesting 2
 * sources". A hydrate is not a source, so alone it has its own text.
 */
function ingestingLabel(
  count: Pick<WorkspaceIngestionCount, "sources" | "hydrating"> | undefined,
): string | null {
  if (!count) return null
  const { sources, hydrating } = count
  if (!sources) return hydrating ? "Indexing the newest commit" : null
  return `Ingesting ${sources} ${sources === 1 ? "source" : "sources"}`
}

/**
 * The ingestion text of one Workspace, or null when nothing ingests. The
 * sidebar pulse and the Status headline of Workspace settings both read it
 * from the one org read, so they always agree.
 */
export function useWorkspaceIngesting(
  orgSlug: string,
  workspaceSlug: string,
): string | null {
  const { data = null } = useQuery({
    ...orgIngestionOptions(orgSlug),
    select: (workspaces) =>
      ingestingLabel(
        workspaces.find((entry) => entry.workspaceSlug === workspaceSlug),
      ),
  })
  return data
}

const STAGE_LABELS: Record<NonNullable<IngestionItem["stage"]>, string> = {
  queued: "Queued. ctxpipe starts the run in a moment.",
  waiting: "Waiting for an earlier run of this repository",
  planning: "Planning the run",
  indexing: "Indexing the code for search",
  ingesting: "Reading the code",
  publishing: "Publishing the knowledge files",
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
    label: item.stage
      ? STAGE_LABELS[item.stage]
      : item.kind === "source_sync"
        ? "Syncing the sources"
        : "Re-ingesting the sources",
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

/** The runs of one source: the run that is the furthest leads. */
export type SourceRuns = {
  kind: IngestionItem["kind"]
  /** The repository ("acme/app") or the provider of a sync ("Linear"). */
  name: string
  /** The runs, the oldest first. */
  runs: IngestionItem[]
  lead: IngestionItem
}

/**
 * The ingestion work of each source, for the source list of Workspace
 * settings. A push makes a run, so one repository can have several. A
 * hydrate is not a source: the Knowledge graph card shows it. A paid
 * re-ingestion is an upgrade: the Upgrades card shows it.
 */
export function groupSourceRuns(items: IngestionItem[]): SourceRuns[] {
  const groups = new Map<string, IngestionItem[]>()
  for (const item of items) {
    if (item.kind === "hydrate" || item.kind === "reingest" || !item.name)
      continue
    const key = `${item.kind}:${item.name}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const rank: Record<NonNullable<IngestionItem["stage"]>, number> = {
    publishing: 6,
    ingesting: 5,
    indexing: 4,
    planning: 3,
    waiting: 2,
    queued: 1,
  }
  return [...groups.values()].flatMap((runs) => {
    const sorted = [...runs].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    )
    const lead = [...sorted].sort(
      (a, b) => (b.stage ? rank[b.stage] : 0) - (a.stage ? rank[a.stage] : 0),
    )[0]
    return lead?.name
      ? [{ kind: lead.kind, name: lead.name, runs: sorted, lead }]
      : []
  })
}

/** One word for the work of a source, for its status: "Publishing". */
export function sourceRunsWord(source: SourceRuns): string {
  if (source.kind === "source_sync") return "Syncing"
  switch (source.lead.stage) {
    case "publishing":
      return "Publishing"
    case "ingesting":
      return "Reading the code"
    case "indexing":
      return "Indexing for search"
    case "planning":
      return "Planning"
    case "waiting":
      return "Waiting for a turn"
    case "queued":
      return "Queued"
    default:
      return "Working"
  }
}
