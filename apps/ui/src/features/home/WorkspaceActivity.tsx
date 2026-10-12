import { IconChevronDown } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import { Button as RACButton } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { useSkeletonHold } from "@/components/ui/Skeleton"
import { activityOptions } from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { formatCalendarDate } from "./calendar-days"
import {
  WorkspaceActivityHeatmap,
  WorkspaceActivityHeatmapSkeleton,
} from "./WorkspaceActivityHeatmap"
import {
  WorkspaceRecentCommits,
  WorkspaceRecentCommitsSkeleton,
} from "./WorkspaceRecentCommits"

export const sectionHeadingClassName =
  "text-xs font-medium uppercase tracking-normal text-teal-400"

/** The activity scope of every workspace. A workspace slug cannot have `*`. */
const ALL_WORKSPACES = "*"

/** The workspace slug of a scope for `activityOptions` (`null`: all). */
function scopeSlug(scope: string | null): string | null {
  return scope === ALL_WORKSPACES ? null : (scope ?? "")
}

/**
 * `workspaceSlug: null` keeps the skeleton while the caller still loads. The
 * activity follows `workspaceSlug` until the user picks a scope in the filter.
 */
export function WorkspaceActivity(props: {
  orgSlug: string
  workspaceSlug: string | null
  workspaces?: readonly Pick<Workspace, "slug" | "displayName">[]
}) {
  const workspaces = props.workspaces ?? []
  const [scopeChoice, setScopeChoice] = useState<string | null>(null)
  const scope = scopeChoice ?? props.workspaceSlug
  const query = useQuery({
    ...activityOptions(props.orgSlug, scopeSlug(scope), null),
    enabled: scope !== null,
  })
  // Keep the scope with the day, so a day of another scope never applies.
  const [selection, setSelection] = useState<{
    scope: string | null
    date: string
  } | null>(null)
  const selectedDate = selection?.scope === scope ? selection.date : null
  const dayQuery = useQuery({
    ...activityOptions(props.orgSlug, scopeSlug(scope), selectedDate),
    enabled: scope !== null && selectedDate !== null,
  })

  // The org read is ready when one workspace is ready. Then All workspaces
  // shows that data at once, with a note for the pending workspaces.
  const loading = useSkeletonHold(
    query.isPending || query.data?.status === "pending",
  )
  const dayLoading = useSkeletonHold(
    selectedDate !== null && dayQuery.isPending,
  )

  const activityHeader = (
    <div className="flex items-center justify-between gap-4">
      <p className={sectionHeadingClassName}>Activity</p>
      {workspaces.length > 1 ? (
        <ActivityScopeMenu
          workspaces={workspaces}
          scope={scope}
          onScopeChange={setScopeChoice}
        />
      ) : null}
    </div>
  )

  if (loading) {
    return <WorkspaceActivityLoading header={activityHeader} />
  }

  const data = query.data
  if (query.isError || data?.status === "failed") {
    return (
      <section>
        {activityHeader}
        <div className="mt-3">
          <WorkspaceActivityError
            onRetry={() => {
              void query.refetch()
            }}
          />
        </div>
      </section>
    )
  }
  if (!data) return <WorkspaceActivityLoading header={activityHeader} />

  const showWorkspace = scope === ALL_WORKSPACES
  const pendingWorkspaces = showWorkspace ? (data.pendingWorkspaces ?? []) : []
  return (
    <>
      <section>
        {activityHeader}
        <div className="mt-3">
          <WorkspaceActivityHeatmap
            days={data.days}
            selectedDate={selectedDate}
            onSelectDate={(date) => {
              setSelection({ scope, date })
            }}
          />
          {pendingWorkspaces.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Activity for {pendingWorkspaces.length}{" "}
              {pendingWorkspaces.length === 1 ? "workspace" : "workspaces"} is
              still loading:{" "}
              {pendingWorkspaces.map((workspace) => workspace.name).join(", ")}.
            </p>
          ) : null}
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
            <WorkspaceRecentCommits
              commits={data.recent}
              showWorkspace={showWorkspace}
            />
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
              showWorkspace={showWorkspace}
              emptyText="No commits on this day."
            />
          )}
        </div>
      </section>
    </>
  )
}

/** A quiet menu like the composer's workspace picker. It sets only the activity scope. */
function ActivityScopeMenu(props: {
  workspaces: readonly Pick<Workspace, "slug" | "displayName">[]
  scope: string | null
  onScopeChange: (scope: string) => void
}) {
  const label =
    props.scope === ALL_WORKSPACES
      ? "All workspaces"
      : (props.workspaces.find((workspace) => workspace.slug === props.scope)
          ?.displayName ?? "Workspace")
  return (
    <MenuTrigger
      placement="bottom end"
      popoverClassName="overflow-hidden rounded-md border-zinc-800 bg-zinc-900"
    >
      <RACButton
        className={cn(
          "-my-1 inline-flex items-center gap-1 rounded-md bg-transparent px-0 py-1 text-sm text-muted-foreground",
          "hover:text-foreground",
          focusVisibleClassName,
        )}
        aria-label={`Show activity for: ${label}`}
      >
        {label}
        <IconChevronDown aria-hidden className="size-4" />
      </RACButton>
      <Menu
        aria-label="Activity scope"
        className="rounded-md"
        selectionMode="single"
        selectedKeys={props.scope === null ? [] : [props.scope]}
        onAction={(key) => props.onScopeChange(String(key))}
      >
        <MenuItem
          id={ALL_WORKSPACES}
          textValue="All workspaces"
          className="rounded-md"
        >
          All workspaces
        </MenuItem>
        {props.workspaces.map((workspace) => (
          <MenuItem
            key={workspace.slug}
            id={workspace.slug}
            textValue={workspace.displayName}
            className="rounded-md"
          >
            {workspace.displayName}
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  )
}

function WorkspaceActivityLoading(props: { header: ReactNode }) {
  return (
    <>
      <section>
        {props.header}
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
