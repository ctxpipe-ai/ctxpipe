import { useQuery } from "@tanstack/react-query"

import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SkeletonText, useSkeletonHold } from "@/components/ui/Skeleton"
import { formatElapsed } from "@/features/workspace-upgrades/upgrade-progress"
import { UpgradeRunProgress } from "@/features/workspace-upgrades/UpgradeRunProgress"
import { useNow } from "@/lib/useNow"

import {
  ingestionItemTitle,
  ingestionProgress,
  workspaceIngestionOptions,
} from "./ingestion"

/**
 * The ingestion work that runs now for the Workspace (CTX-959): each
 * repository or source, its stage, how far it is, and the time so far. A
 * hydrate of the newest commit shows as one line, and only when it is slow.
 * It shows in the Working part of the Status group (CTX-980), only while the
 * org read says that the Workspace ingests, so it has no empty state.
 */
export function WorkspaceIngestingNow(props: {
  orgSlug: string
  workspaceSlug: string
}) {
  const query = useQuery(
    workspaceIngestionOptions(props.orgSlug, props.workspaceSlug),
  )
  const loading = useSkeletonHold(query.isPending)
  const items = query.data ?? []
  const runs = items.filter((item) => item.kind !== "hydrate")
  const hydrate = items.find((item) => item.kind === "hydrate")
  const now = useNow(hydrate !== undefined)

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      {loading ? (
        <SkeletonText className="text-sm" />
      ) : query.isError ? (
        <InlineAlert
          variant="error"
          actions={
            <Button variant="secondary" onPress={() => void query.refetch()}>
              Try again
            </Button>
          }
        >
          Could not load the ingestion state.
        </InlineAlert>
      ) : (
        <>
          {runs.length ? (
            <>
              <ul className="flex flex-col gap-4" aria-label="Ingesting now">
                {runs.map((item) => (
                  <li key={item.id}>
                    <p className="truncate font-mono text-sm text-foreground">
                      {ingestionItemTitle(item)}
                    </p>
                    <UpgradeRunProgress
                      title={ingestionItemTitle(item)}
                      progress={ingestionProgress(item)}
                      hideLeaveHint
                    />
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                You can leave this page. The work continues.
              </p>
            </>
          ) : null}
          {hydrate ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <span
                aria-hidden
                className="ctx-status-pulse size-1.5 shrink-0 rounded-full bg-teal-400"
              />
              Indexing the newest commit…
              <span className="text-xs tabular-nums">
                {formatElapsed(hydrate.startedAt, now)}
              </span>
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
