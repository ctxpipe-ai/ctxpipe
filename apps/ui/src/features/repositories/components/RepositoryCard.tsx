import {
  IconDots,
  IconExternalLink,
  IconGitBranch,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react"
import { Button } from "@/components/ui/Button"
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/Menu"
import { githubWebUrl } from "@/features/repositories/github-web-url"
import { repositoryCardPresentation } from "../repositoryCardPresentation"
import type { Repository } from "../types"
import { RepositoryStatus } from "./RepositoryStatus"

interface RepositoryCardProps {
  repo: Repository
  onDelete: (repo: Repository) => void
  onRetry: (repo: Repository) => void
  isRetrying?: boolean
  isDeleting?: boolean
  interactive?: boolean
}

export function RepositoryCard({
  repo,
  onDelete,
  onRetry,
  isRetrying = false,
  isDeleting = false,
  interactive = true,
}: RepositoryCardProps) {
  const webUrl = githubWebUrl(repo.gitUrl)
  const {
    displayStatus,
    indexingDetail,
    failedDetail,
    issuesDetail,
    outOfDateDetail,
    showRetryIndexing,
    queryable,
  } = repositoryCardPresentation(repo)
  const isUnindexing = repo.indexingStatus === "unindexing"
  const isCompleteWithIssues = displayStatus === "complete_with_issues"

  return (
    <div className="ctx-repo-row group">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div
          className={`ctx-node h-10 w-10 shrink-0 transition-[color,background-color,border-color] duration-150 ease-out [&_svg]:h-4 [&_svg]:w-4 [&_svg]:transition-colors ${
            displayStatus === "ready"
              ? "border-teal-400 bg-teal-400/5 [&_svg]:text-teal-400"
              : isCompleteWithIssues
                ? "border-amber-200/80 bg-amber-200/5 [&_svg]:text-amber-200"
                : "group-hover:border-teal-400 group-hover:bg-teal-400/5 [&_svg]:text-muted-foreground group-hover:[&_svg]:text-teal-400"
          }`}
        >
          <IconGitBranch
            aria-hidden
            className={`h-4 w-4 ${
              displayStatus === "ready"
                ? "text-teal-400"
                : isCompleteWithIssues
                  ? "text-amber-200"
                  : "text-muted-foreground"
            }`}
          />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm text-foreground">{repo.name}</p>
          <p
            className="truncate text-xs text-muted-foreground"
            title={repo.gitUrl}
          >
            {repo.gitUrl}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-4 sm:gap-6">
        <RepositoryStatus
          status={displayStatus}
          indexingDetail={indexingDetail}
          failedDetail={failedDetail}
          issuesDetail={issuesDetail}
          indexedAt={queryable ? repo.lastIngestedAt : null}
          outOfDateDetail={outOfDateDetail}
          interactive={interactive}
        />

        {interactive ? (
          <MenuTrigger
            placement="bottom end"
            popoverClassName="rounded-none border-border bg-card"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-none"
              aria-label="Repository actions"
              isDisabled={isRetrying || isDeleting}
            >
              <IconDots className="h-4 w-4" />
            </Button>
            <Menu
              onAction={(key) => {
                if (key === "delete") onDelete(repo)
                if (key === "retry") onRetry(repo)
                if (key === "github" && webUrl) {
                  window.open(webUrl, "_blank", "noopener,noreferrer")
                }
              }}
            >
              {webUrl ? (
                <>
                  <MenuItem id="github" textValue="View on GitHub">
                    <IconExternalLink aria-hidden className="h-4 w-4" />
                    View on GitHub
                  </MenuItem>
                  <MenuSeparator />
                </>
              ) : null}
              {showRetryIndexing ? (
                <>
                  <MenuItem
                    id="retry"
                    textValue="Retry indexing"
                    isDisabled={isRetrying}
                  >
                    <IconRefresh aria-hidden className="h-4 w-4" />
                    Retry indexing
                  </MenuItem>
                  <MenuSeparator />
                </>
              ) : null}
              <MenuItem
                id="delete"
                textValue={
                  isUnindexing ? "Retry unindexing" : "Unindex repository"
                }
                className="text-destructive"
                isDisabled={isDeleting}
              >
                {isUnindexing ? (
                  <IconRefresh aria-hidden className="h-4 w-4" />
                ) : (
                  <IconTrash aria-hidden className="h-4 w-4" />
                )}
                {isUnindexing ? "Retry unindexing" : "Unindex"}
              </MenuItem>
            </Menu>
          </MenuTrigger>
        ) : (
          <span className="inline-flex h-8 w-8 shrink-0" aria-hidden />
        )}
      </div>
    </div>
  )
}
