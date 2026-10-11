import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { useSkeletonHold } from "@/components/ui/Skeleton"
import { workspaceActivityOptions } from "@/features/workspaces/queries"
import { formatCalendarDate } from "./calendar-days"
import {
  WorkspaceActivityHeatmap,
  WorkspaceActivityHeatmapSkeleton,
} from "./WorkspaceActivityHeatmap"
import {
  WorkspaceRecentCommits,
  WorkspaceRecentCommitsSkeleton,
} from "./WorkspaceRecentCommits"

const sectionHeadingClassName =
  "text-xs font-medium uppercase tracking-normal text-teal-400"

/** `workspaceSlug: null` keeps the skeleton while the caller still loads. */
export function WorkspaceActivity(props: {
  orgSlug: string
  workspaceSlug: string | null
}) {
  const query = useQuery({
    ...workspaceActivityOptions(props.orgSlug, props.workspaceSlug ?? ""),
    enabled: props.workspaceSlug !== null,
  })
  // Keep the workspace with the day, so a day of another workspace never applies.
  const [selection, setSelection] = useState<{
    workspaceSlug: string | null
    date: string
  } | null>(null)
  const selectedDate =
    selection?.workspaceSlug === props.workspaceSlug ? selection.date : null
  const dayQuery = useQuery({
    ...workspaceActivityOptions(
      props.orgSlug,
      props.workspaceSlug ?? "",
      selectedDate,
    ),
    enabled: props.workspaceSlug !== null && selectedDate !== null,
  })

  const loading = useSkeletonHold(
    query.isPending || query.data?.status === "pending",
  )
  const dayLoading = useSkeletonHold(
    selectedDate !== null && dayQuery.isPending,
  )

  if (loading) {
    return <WorkspaceActivityLoading />
  }

  if (query.isError) {
    return (
      <WorkspaceActivityError
        onRetry={() => {
          void query.refetch()
        }}
      />
    )
  }

  const data = query.data
  if (!data) return <WorkspaceActivityLoading />

  if (data.status === "failed") {
    return (
      <WorkspaceActivityError
        onRetry={() => {
          void query.refetch()
        }}
      />
    )
  }

  return (
    <>
      <section>
        <p className={sectionHeadingClassName}>Activity</p>
        <div className="mt-3">
          <WorkspaceActivityHeatmap
            days={data.days}
            selectedDate={selectedDate}
            onSelectDate={(date) => {
              setSelection({ workspaceSlug: props.workspaceSlug, date })
            }}
          />
        </div>
      </section>
      <section>
        <div className="flex items-center justify-between gap-4">
          <p className={sectionHeadingClassName}>
            {selectedDate ? formatCalendarDate(selectedDate) : "Recent"}
          </p>
          {selectedDate ? (
            <Button
              variant="quiet"
              onPress={() => setSelection(null)}
              className="-my-1.5 h-7 px-2"
            >
              Reset view
            </Button>
          ) : null}
        </div>
        <div className="mt-3">
          {selectedDate === null ? (
            <WorkspaceRecentCommits commits={data.recent} />
          ) : dayLoading ? (
            <WorkspaceRecentCommitsSkeleton />
          ) : dayQuery.isError ? (
            <WorkspaceActivityError
              onRetry={() => {
                void dayQuery.refetch()
              }}
            />
          ) : (
            <WorkspaceRecentCommits
              commits={dayQuery.data?.recent ?? []}
              emptyText="No commits on this day."
            />
          )}
        </div>
      </section>
    </>
  )
}

function WorkspaceActivityLoading() {
  return (
    <>
      <section>
        <p className={sectionHeadingClassName}>Activity</p>
        <div className="mt-3">
          <WorkspaceActivityHeatmapSkeleton />
        </div>
      </section>
      <section>
        <p className={sectionHeadingClassName}>Recent</p>
        <div className="mt-3">
          <WorkspaceRecentCommitsSkeleton />
        </div>
      </section>
    </>
  )
}

function WorkspaceActivityError(props: { onRetry: () => void }) {
  return (
    <InlineAlert
      variant="error"
      title="Could not load activity"
      actions={
        <Button
          variant="outline"
          className="rounded-md"
          onPress={props.onRetry}
        >
          Retry
        </Button>
      }
    >
      The composer still works. Try again to load the heatmap and recent
      commits.
    </InlineAlert>
  )
}
