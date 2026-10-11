import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { useSkeletonHold } from "@/components/ui/Skeleton"
import { workspaceActivityOptions } from "@/features/workspaces/queries"
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

  const loading = useSkeletonHold(
    query.isPending || query.data?.status === "pending",
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
          <WorkspaceActivityHeatmap days={data.days} />
        </div>
      </section>
      <section>
        <p className={sectionHeadingClassName}>Recent</p>
        <div className="mt-3">
          <WorkspaceRecentCommits commits={data.recent} />
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
