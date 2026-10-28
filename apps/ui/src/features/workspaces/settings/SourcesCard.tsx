import { useQuery } from "@tanstack/react-query"

import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import {
  repositoryNeedsAttention,
  repositoryRows,
} from "@/features/workspace-sources/GithubSourceRepositories"
import { workspaceSourcesOptions } from "@/features/workspace-sources/queries"
import type {
  SourceLiveStatus,
  SourceLiveStatusLookup,
} from "@/features/workspace-sources/SourceActivityRows"
import { WorkspaceSources } from "@/features/workspace-sources/WorkspaceSources"

import {
  groupSourceRuns,
  ingestionProgress,
  type SourceRuns,
  sourceRunsWord,
  useWorkspaceIngesting,
  workspaceIngestionOptions,
} from "../ingestion"
import type { WorkspaceDetail } from "../types"
import { SettingsCard } from "./SettingsCard"

/**
 * The ingestion work of the Workspace now: the runs of each source, and the
 * hydrate of the newest commit. It reads only while the org read (the
 * sidebar) says that the Workspace ingests. A paid re-ingestion is an
 * upgrade: the Upgrades card shows it.
 */
export function useWorkspaceActivity(orgSlug: string, workspaceSlug: string) {
  const ingesting = useWorkspaceIngesting(orgSlug, workspaceSlug)
  const query = useQuery({
    ...workspaceIngestionOptions(orgSlug, workspaceSlug),
    enabled: ingesting !== null,
  })
  const items = ingesting === null ? [] : (query.data ?? [])
  return {
    status: query.isError
      ? ("error" as const)
      : ingesting !== null && query.isPending
        ? ("loading" as const)
        : ("ready" as const),
    retry: () => void query.refetch(),
    sources: groupSourceRuns(items),
    hydrate: items.find((item) => item.kind === "hydrate") ?? null,
  }
}

/**
 * Do the sources need the user: a source with a problem, a repository that
 * needs attention (the rule of the GitHub rows), or a source change that waits
 * for its merge. The same read as the sources list, from the same cache.
 */
export function useSourcesNeedYou(
  orgSlug: string,
  workspace: WorkspaceDetail,
): boolean {
  const sources = useQuery(
    workspaceSourcesOptions(orgSlug, workspace.slug),
  ).data
  const items = sources?.items ?? []
  return (
    items.some((item) => item.status !== "ok") ||
    (sources?.pendingChanges.length ?? 0) > 0 ||
    repositoryRows(
      workspace.linkedRepositories ?? [],
      items.filter((item) => item.provider === "github"),
    ).some(repositoryNeedsAttention)
  )
}

function liveStatusOf(source: SourceRuns | undefined): SourceLiveStatus | null {
  if (!source) return null
  return {
    // The word and the time of one run: the run that is the furthest.
    label: sourceRunsWord(source),
    since: source.lead.startedAt,
    runs: source.runs.map((run) => {
      const progress = ingestionProgress(run)
      return {
        key: run.id,
        label: progress.label,
        count: progress.count,
        fraction: progress.fraction,
        detail: progress.detail,
        since: run.startedAt,
      }
    }),
  }
}

/**
 * The sources of the Workspace, each with its state and its live work in its
 * own row: what ctxpipe does with it now, and for how long. No separate
 * "ingesting now" list repeats them.
 */
export function SourcesCard(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  activity: ReturnType<typeof useWorkspaceActivity>
  needsYou: boolean
}) {
  const { orgSlug, workspace, activity } = props
  // A repository run has the name of the repository; a connector sync has
  // the name of its provider ("Linear"). While the work loads or cannot load,
  // a row shows its state only, in the same layout.
  const ready = activity.status === "ready"
  const liveStatus: SourceLiveStatusLookup = {
    repository: (title) =>
      ready
        ? liveStatusOf(
            activity.sources.find(
              (source) =>
                source.kind === "repository" &&
                source.name.toLowerCase() === title.toLowerCase(),
            ),
          )
        : null,
    provider: (label) =>
      ready
        ? liveStatusOf(
            activity.sources.find(
              (source) =>
                source.kind === "source_sync" && source.name === label,
            ),
          )
        : null,
  }
  return (
    <SettingsCard part="sources" needsYou={props.needsYou}>
      {activity.status === "loading" ? (
        <p
          className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"
          aria-busy
        >
          <span
            aria-hidden
            className="ctx-status-pulse size-1.5 shrink-0 rounded-full bg-zinc-500"
          />
          Loading what each source does now…
        </p>
      ) : activity.status === "error" ? (
        <div className="mb-4">
          <InlineAlert
            variant="warning"
            actions={
              <Button variant="secondary" onPress={activity.retry}>
                Try again
              </Button>
            }
          >
            Could not load the ingestion state. The list still shows each source
            and its connection.
          </InlineAlert>
        </div>
      ) : null}
      <WorkspaceSources
        orgSlug={orgSlug}
        workspaceSlug={workspace.slug}
        linkedRepositories={workspace.linkedRepositories}
        liveStatus={liveStatus}
      />
      {activity.sources.length ? (
        <p className="mt-3 text-xs text-muted-foreground">
          You can leave this page. The work continues.
        </p>
      ) : null}
    </SettingsCard>
  )
}
