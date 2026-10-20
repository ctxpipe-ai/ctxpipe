import { IconExternalLink } from "@tabler/icons-react"
import { useState } from "react"
import {
  Link as AriaLink,
  Focusable,
  Tooltip,
  TooltipTrigger,
} from "react-aria-components"
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton"
import type { WorkspaceActivityCommit } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { formatDate } from "@/lib/format"
import { cn } from "@/lib/utils"

export function WorkspaceRecentCommits(props: {
  commits: readonly WorkspaceActivityCommit[]
  emptyText?: string
  /** Show the workspace of each commit (the activity of all workspaces). */
  showWorkspace?: boolean
}) {
  if (props.commits.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {props.emptyText ?? "No commits on the default branch yet."}
      </p>
    )
  }

  return (
    <ul className="list-none p-0">
      {props.commits.map((commit) => (
        <li
          key={`${commit.workspaceSlug}/${commit.sha}`}
          className="flex items-center gap-3"
        >
          <CommitLineNode />
          <CommitRow commit={commit} showWorkspace={props.showWorkspace} />
        </li>
      ))}
    </ul>
  )
}

/**
 * One segment of the commit line, with the node of its row. Each row draws
 * its own segment over its full height, so the line stays aligned at any row
 * height and does not move when a page adds rows.
 */
function CommitLineNode() {
  return (
    <span
      aria-hidden
      data-commit-line
      className="relative flex w-3 shrink-0 items-center justify-center self-stretch"
    >
      <span className="absolute inset-y-0 w-px bg-border" />
      <span className="relative size-2 rounded-full border border-muted-foreground bg-background" />
    </span>
  )
}

/**
 * A round avatar: the GitHub avatar of `login`, or the first letter of the
 * name when there is no login or the image does not load. The image URL is
 * public; the request sends no token and no referrer.
 */
export function AuthorAvatar(props: {
  name: string
  login?: string | null
  className?: string
}) {
  const [failedLogin, setFailedLogin] = useState<string | null>(null)
  const className = cn(
    "flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-medium text-zinc-300 uppercase",
    props.className,
  )
  if (props.login && failedLogin !== props.login) {
    const login = props.login
    return (
      <img
        src={`https://github.com/${encodeURIComponent(login)}.png?size=40`}
        alt=""
        aria-hidden
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedLogin(login)}
        className={cn(className, "object-cover")}
      />
    )
  }
  return (
    <span aria-hidden className={className}>
      {props.name.trim().charAt(0) || "?"}
    </span>
  )
}

/** The full local date and time of an ISO time. */
export function formatCommitTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso))
}

function CommitRow({
  commit,
  showWorkspace,
}: {
  commit: WorkspaceActivityCommit
  showWorkspace?: boolean
}) {
  const shortSha = commit.sha.slice(0, 7)
  const sha = commit.htmlUrl ? (
    <AriaLink
      href={commit.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Commit ${shortSha} (opens in a new tab)`}
      className={cn(
        focusVisibleClassName,
        "group inline-flex shrink-0 items-center gap-1 rounded-md font-mono text-xs text-muted-foreground transition-colors hover:text-teal-400",
      )}
    >
      {shortSha}
      <IconExternalLink
        className="size-3 shrink-0 opacity-0 transition-opacity group-data-[hovered]:opacity-100 group-data-[focus-visible]:opacity-100"
        aria-hidden
      />
    </AriaLink>
  ) : (
    // The same box as a link, so the hashes stay in one column.
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground">
      {shortSha}
      <span className="size-3" aria-hidden />
    </span>
  )

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 py-2 text-sm">
      <AuthorAvatar name={commit.authorName} login={commit.authorLogin} />
      <span className="sr-only">{commit.authorName}:</span>
      <span className="min-w-0 flex-1 truncate text-foreground">
        {commit.subject}
      </span>
      {showWorkspace ? (
        <span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">
          {commit.workspaceName}
        </span>
      ) : null}
      <TooltipTrigger delay={200}>
        <Focusable>
          <time
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users open the date tooltip with focus.
            tabIndex={0}
            dateTime={commit.committedAt}
            className={cn(
              focusVisibleClassName,
              "shrink-0 rounded-md text-xs whitespace-nowrap text-muted-foreground",
            )}
          >
            {formatDate(commit.committedAt)}
          </time>
        </Focusable>
        <Tooltip
          placement="top"
          offset={6}
          className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100 shadow-md"
        >
          {formatCommitTime(commit.committedAt)}
        </Tooltip>
      </TooltipTrigger>
      {sha}
    </div>
  )
}

/**
 * Three rows hold the place of the list. The opacity falls with each row, so
 * the skeleton does not guess how many commits come.
 */
const skeletonRowOpacity = ["opacity-75", "opacity-50", "opacity-25"]

export function WorkspaceRecentCommitsSkeleton() {
  return (
    <div aria-busy>
      <span className="sr-only">Loading recent commits</span>
      <ul className="list-none p-0">
        {skeletonRowOpacity.map((opacity) => (
          <li key={opacity} className={cn("flex items-center gap-3", opacity)}>
            {/* The width of the line node, without a dot the list may not have. */}
            <span aria-hidden className="w-3 shrink-0" />
            <div className="flex min-w-0 flex-1 items-center gap-3 py-2 text-sm">
              <Skeleton className="size-5 shrink-0 rounded-full" />
              <SkeletonText className="min-w-0 flex-1" boneClassName="w-3/4" />
              <SkeletonText className="w-16 text-xs" boneClassName="w-full" />
              <SkeletonText className="w-16 text-xs" boneClassName="w-full" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
