import { SkeletonRow } from "@/components/ui/Skeleton"
import type { WorkspaceActivityCommit } from "@/features/workspaces/types"
import { formatDate } from "@/lib/format"

export function WorkspaceRecentCommits(props: {
  commits: readonly WorkspaceActivityCommit[]
}) {
  if (props.commits.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No commits on the default branch yet.
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
    <a
      href={commit.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-foreground hover:text-teal-400"
    >
      {commit.subject}
    </a>
  ) : (
    <span className="font-medium text-foreground">{commit.subject}</span>
  )
  const sha = commit.htmlUrl ? (
    <a
      href={commit.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-xs text-muted-foreground hover:text-teal-400"
    >
      {shortSha}
    </a>
  ) : (
    <span className="font-mono text-xs text-muted-foreground">{shortSha}</span>
  )

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="truncate text-sm">{subject}</p>
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
      <SkeletonRow size="catalog" lines={2} />
      <SkeletonRow size="catalog" lines={2} />
      <SkeletonRow size="catalog" lines={2} />
      <SkeletonRow size="catalog" lines={2} />
      <SkeletonRow size="catalog" lines={2} />
    </div>
  )
}
