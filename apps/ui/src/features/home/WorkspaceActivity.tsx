import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { workspaceActivityOptions } from "@/features/workspaces/queries"
import {
  WorkspaceActivityHeatmap,
  WorkspaceActivityHeatmapSkeleton,
} from "./WorkspaceActivityHeatmap"
import {
  WorkspaceRecentCommits,
  WorkspaceRecentCommitsSkeleton,
} from "./WorkspaceRecentCommits"

export function WorkspaceActivity(props: {
  orgSlug: string
  workspaceSlug: string
}) {
  const query = useQuery(
    workspaceActivityOptions(props.orgSlug, props.workspaceSlug),
  )

  if (query.isPending || query.data?.status === "pending") {
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
    <section className="space-y-10">
      <div>
        <p className="ctx-label text-teal-400">Activity</p>
        <div className="mt-3">
          <WorkspaceActivityHeatmap days={data.days} />
        </div>
      </div>
      <div>
        <p className="ctx-label text-teal-400">Recent</p>
        <div className="mt-3">
          <WorkspaceRecentCommits commits={data.recent} />
        </div>
      </div>
    </section>
  )
}

function WorkspaceActivityLoading() {
  return (
    <section className="space-y-10">
      <div>
        <p className="ctx-label text-teal-400">Activity</p>
        <div className="mt-3">
          <WorkspaceActivityHeatmapSkeleton />
        </div>
      </div>
      <div>
        <p className="ctx-label text-teal-400">Recent</p>
        <div className="mt-3">
          <WorkspaceRecentCommitsSkeleton />
        </div>
      </div>
    </section>
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
          className="rounded-lg"
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
