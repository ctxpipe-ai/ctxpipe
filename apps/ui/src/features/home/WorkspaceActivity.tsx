import { IconChevronDown } from "@tabler/icons-react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Button as RACButton } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { useSkeletonHold } from "@/components/ui/Skeleton"
import {
  type ActivityCommitFilters,
  activityCommitsOptions,
  activityOptions,
} from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useUrgentValue } from "@/lib/useUrgentValue"
import { cn } from "@/lib/utils"
import {
  type ActivitySearch,
  activitySearch,
  activitySearchKey,
  utcDayBefore,
} from "./activity-search"
import { formatCalendarDate } from "./calendar-days"
import {
  WorkspaceActivityHeatmap,
  WorkspaceActivityHeatmapSkeleton,
} from "./WorkspaceActivityHeatmap"
import {
  AuthorAvatar,
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
 * The activity view (scope, author, day, date range) is in the URL search
 * params. The controls set it in the press handler first, so they move at
 * once, then write the URL.
 */
function useActivitySearch(orgSlug: string) {
  const navigate = useNavigate()
  const urlSearch = activitySearch(
    useSearch({ strict: false }) as Record<string, unknown>,
  )
  const [search, setSearch] = useUrgentValue(
    urlSearch,
    `${orgSlug}:${activitySearchKey(urlSearch)}`,
  )
  const update = (next: ActivitySearch) => {
    setSearch(next)
    void navigate({
      to: "/$orgSlug",
      params: { orgSlug },
      search: (prev) => ({
        ...prev,
        scope: next.scope,
        author: next.author,
        day: next.day,
        since: next.since,
        until: next.until,
      }),
      replace: true,
    })
  }
  return [search, update] as const
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
  const [search, setSearch] = useActivitySearch(props.orgSlug)
  const scope =
    props.workspaceSlug === null ? null : (search.scope ?? props.workspaceSlug)
  const query = useQuery({
    ...activityOptions(props.orgSlug, scopeSlug(scope), null),
    enabled: scope !== null,
  })
  const filters: ActivityCommitFilters = {
    author: search.author,
    date: search.day,
    since: search.since,
    until: search.until,
  }
  const filtered = Object.values(filters).some((value) => value !== undefined)
  const ready = query.data?.status === "ready"
  const listQuery = useInfiniteQuery({
    ...activityCommitsOptions(props.orgSlug, scopeSlug(scope), filters),
    enabled: scope !== null && ready,
    // While a workspace of the org is still loading, read the list again
    // with the heatmap, so its commits show when they are there.
    refetchInterval: query.data?.pendingWorkspaces?.length ? 10_000 : false,
  })

  // The org read is ready when one workspace is ready. Then All workspaces
  // shows that data at once, with a note for the pending workspaces.
  const loading = useSkeletonHold(
    query.isPending || query.data?.status === "pending",
  )
  const listLoading = useSkeletonHold(ready && listQuery.isPending)

  const activityHeader = (
    <div className="flex items-center justify-between gap-4">
      <p className={sectionHeadingClassName}>Activity</p>
      {workspaces.length > 1 ? (
        <ActivityScopeMenu
          workspaces={workspaces}
          scope={scope}
          // Authors and days of one scope do not apply to another.
          onScopeChange={(next) =>
            setSearch({
              ...search,
              scope: next,
              author: undefined,
              day: undefined,
            })
          }
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
  const commits = listQuery.data?.pages.flatMap((page) => page.recent) ?? []
  const emptyText = filtered
    ? search.day && !search.author && !search.since && !search.until
      ? "No commits on this day."
      : "No commits match these filters."
    : undefined
  return (
    <>
      <section>
        {activityHeader}
        <div className="mt-3">
          <WorkspaceActivityHeatmap
            days={data.days}
            selectedDate={search.day ?? null}
            onSelectDate={(date) => {
              setSearch({ ...search, day: date })
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
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className={sectionHeadingClassName}>
            {search.day ? formatCalendarDate(search.day) : "Recent"}
          </p>
          <div className="flex items-center gap-4">
            <AuthorFilterMenu
              authors={data.authors}
              author={search.author}
              onAuthorChange={(author) => setSearch({ ...search, author })}
            />
            <DateRangeMenu
              since={search.since}
              until={search.until}
              onRangeChange={(range) => setSearch({ ...search, ...range })}
            />
            {filtered ? (
              <Button
                variant="quiet"
                onPress={() => setSearch({ scope: search.scope })}
                className="-my-1.5 h-7 px-2"
              >
                Reset
              </Button>
            ) : null}
          </div>
        </div>
        <div className="mt-3">
          {listLoading ? (
            <WorkspaceRecentCommitsSkeleton />
          ) : listQuery.isError ? (
            <WorkspaceActivityError
              onRetry={() => {
                void listQuery.refetch()
              }}
            />
          ) : (
            <>
              <WorkspaceRecentCommits
                commits={commits}
                showWorkspace={showWorkspace}
                emptyText={emptyText}
              />
              {listQuery.hasNextPage ? (
                <div className="mt-2 flex items-center gap-3 pl-6">
                  <Button
                    variant="quiet"
                    isPending={listQuery.isFetchingNextPage}
                    onPress={() => {
                      void listQuery.fetchNextPage()
                    }}
                    className="-my-1.5 h-7 px-2"
                  >
                    Load more
                  </Button>
                  {listQuery.isFetchNextPageError ? (
                    <p className="text-xs text-muted-foreground">
                      Could not load more commits. Try again.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </>
  )
}

/** A quiet menu trigger, like the scope menu. */
const quietMenuButtonClassName = cn(
  "-my-1 inline-flex max-w-48 items-center gap-1 rounded-md bg-transparent px-0 py-1 text-sm text-muted-foreground",
  "hover:text-foreground",
  focusVisibleClassName,
)

/** Picks one author of the heatmap window, or all authors. */
function AuthorFilterMenu(props: {
  authors: readonly { name: string; count: number }[]
  author: string | undefined
  onAuthorChange: (author: string | undefined) => void
}) {
  const ALL_AUTHORS = "\u0000all"
  const label = props.author ?? "All authors"
  return (
    <MenuTrigger
      placement="bottom end"
      popoverClassName="overflow-hidden rounded-md border-zinc-800 bg-zinc-900"
    >
      <RACButton
        className={quietMenuButtonClassName}
        aria-label={`Filter commits by author: ${label}`}
      >
        {props.author ? <AuthorAvatar name={props.author} /> : null}
        <span className="truncate">{label}</span>
        <IconChevronDown aria-hidden className="size-4 shrink-0" />
      </RACButton>
      <Menu
        aria-label="Author"
        className="max-h-80 rounded-md"
        selectionMode="single"
        selectedKeys={[props.author ?? ALL_AUTHORS]}
        onAction={(key) =>
          props.onAuthorChange(key === ALL_AUTHORS ? undefined : String(key))
        }
      >
        <MenuItem
          id={ALL_AUTHORS}
          textValue="All authors"
          className="rounded-md"
        >
          All authors
        </MenuItem>
        {props.authors.map((author) => (
          <MenuItem
            key={author.name}
            id={author.name}
            textValue={author.name}
            className="rounded-md"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <AuthorAvatar name={author.name} />
              <span className="truncate">{author.name}</span>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {author.count}
              </span>
            </span>
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  )
}

const RANGE_PRESETS = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
] as const

/** The label of a date range: a preset, or the days of the range. */
function rangeLabel(since: string | undefined, until: string | undefined) {
  if (!since && !until) return "Any time"
  if (!until) {
    const preset = RANGE_PRESETS.find(
      (item) => since === utcDayBefore(item.days - 1),
    )
    if (preset) return preset.label
    return `Since ${formatCalendarDate(since ?? "")}`
  }
  if (!since) return `Until ${formatCalendarDate(until)}`
  return `${formatCalendarDate(since)} – ${formatCalendarDate(until)}`
}

/** Picks the date range of the commit list. */
function DateRangeMenu(props: {
  since: string | undefined
  until: string | undefined
  onRangeChange: (range: { since?: string; until?: string }) => void
}) {
  const ANY_TIME = "any"
  const label = rangeLabel(props.since, props.until)
  const selected =
    !props.since && !props.until
      ? ANY_TIME
      : RANGE_PRESETS.find((item) => item.label === label)?.id
  return (
    <MenuTrigger
      placement="bottom end"
      popoverClassName="overflow-hidden rounded-md border-zinc-800 bg-zinc-900"
    >
      <RACButton
        className={quietMenuButtonClassName}
        aria-label={`Filter commits by date: ${label}`}
      >
        <span className="truncate">{label}</span>
        <IconChevronDown aria-hidden className="size-4 shrink-0" />
      </RACButton>
      <Menu
        aria-label="Date range"
        className="rounded-md"
        selectionMode="single"
        selectedKeys={selected ? [selected] : []}
        onAction={(key) => {
          const preset = RANGE_PRESETS.find((item) => item.id === key)
          props.onRangeChange(
            preset
              ? { since: utcDayBefore(preset.days - 1), until: undefined }
              : { since: undefined, until: undefined },
          )
        }}
      >
        <MenuItem id={ANY_TIME} textValue="Any time" className="rounded-md">
          Any time
        </MenuItem>
        {RANGE_PRESETS.map((item) => (
          <MenuItem
            key={item.id}
            id={item.id}
            textValue={item.label}
            className="rounded-md"
          >
            {item.label}
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
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
