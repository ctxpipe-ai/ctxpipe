import { IconExternalLink } from "@tabler/icons-react"
import { Link as AriaLink } from "react-aria-components"
import { SkeletonText } from "@/components/ui/Skeleton"
import type { WorkspaceActivityCommit } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { formatDate } from "@/lib/format"
import { cn } from "@/lib/utils"

export function WorkspaceRecentCommits(props: {
  commits: readonly WorkspaceActivityCommit[]
  emptyText?: string
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
          key={commit.sha}
          className="border-b border-white/[0.06] py-3 last:border-b-0"
        >
          <CommitRow commit={commit} />
        </li>
      ))}
    </ul>
  )
}

function CommitRow({ commit }: { commit: WorkspaceActivityCommit }) {
  const shortSha = commit.sha.slice(0, 7)
  const meta = `${commit.authorName} · ${formatDate(commit.committedAt)}`
  const subject = commit.htmlUrl ? (
    <AriaLink
      href={commit.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${commit.subject} (opens in a new tab)`}
      className={cn(
        focusVisibleClassName,
        "group inline-flex min-w-0 items-center gap-1.5 rounded-md font-medium text-foreground transition-colors hover:text-teal-400",
      )}
    >
      <span className="truncate">{commit.subject}</span>
      <IconExternalLink
        className="size-3.5 shrink-0 opacity-0 transition-opacity group-data-[hovered]:opacity-100 group-data-[focus-visible]:opacity-100"
        aria-hidden
      />
    </AriaLink>
  ) : (
    <span className="truncate font-medium text-foreground">
      {commit.subject}
    </span>
  )
  const sha = commit.htmlUrl ? (
    <AriaLink
      href={commit.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Commit ${shortSha} (opens in a new tab)`}
      className={cn(
        focusVisibleClassName,
        "rounded-md font-mono text-xs text-muted-foreground transition-colors hover:text-teal-400",
      )}
    >
      {shortSha}
    </AriaLink>
  ) : (
    <span className="font-mono text-xs text-muted-foreground">{shortSha}</span>
  )

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="flex min-w-0 text-sm">{subject}</p>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">{meta}</p>
      </div>
      {sha}
    </div>
  )
}

export function WorkspaceRecentCommitsSkeleton() {
  return (
    <div aria-busy>
      <span className="sr-only">Loading recent commits</span>
      <ul className="list-none p-0">
        {[0, 1, 2, 3, 4].map((row) => (
          <li
            key={row}
            className="flex items-start justify-between gap-4 border-b border-white/[0.06] py-3 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <SkeletonText className="text-sm" boneClassName="w-3/4" />
              <SkeletonText className="mt-0.5 text-sm" boneClassName="w-1/2" />
            </div>
            <SkeletonText className="w-14 text-xs" boneClassName="w-full" />
          </li>
        ))}
      </ul>
    </div>
  )
}
