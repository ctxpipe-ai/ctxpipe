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
import {
  formatIndexingStepLabel,
  getRepositoryStatusDisplay,
  type Repository,
} from "../types"
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
  const status = repo.indexingStatus
  const displayStatus = getRepositoryStatusDisplay(repo)
  const isReady = status === "ready"
  const isFailed = status === "failed"
  const isUnindexing = status === "unindexing"

  const stepLabel =
    displayStatus === "queued" ||
    displayStatus === "running" ||
    displayStatus === "refreshing"
      ? formatIndexingStepLabel(repo)
      : null
  const indexingDetail =
    stepLabel ??
    (displayStatus === "running" && repo.indexingReason === "merge"
      ? "indexing merge"
      : displayStatus === "running" && repo.indexingReason === "push"
        ? "indexing recent changes"
        : null)
  const failedDetail =
    displayStatus === "failed" ? repo.indexingError?.trim() || null : null
  const outOfDateDetail =
    displayStatus === "out-of-date" && repo.lastIngestedHash
      ? {
          lastIngestedHash: repo.lastIngestedHash,
          lastIngestedAt: repo.lastIngestedAt,
          indexingError: repo.indexingError,
        }
      : null

  return (
    <div className="ctx-repo-row group">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div
          className={`ctx-node h-10 w-10 shrink-0 transition-[color,background-color,border-color] duration-150 ease-out [&_svg]:h-4 [&_svg]:w-4 [&_svg]:transition-colors ${
            isReady
              ? "border-teal-400 bg-teal-400/5 [&_svg]:text-teal-400"
              : "group-hover:border-teal-400 group-hover:bg-teal-400/5 [&_svg]:text-muted-foreground group-hover:[&_svg]:text-teal-400"
          }`}
        >
          <IconGitBranch
            aria-hidden
            className={`h-4 w-4 ${isReady ? "text-teal-400" : "text-muted-foreground"}`}
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
          indexedAt={isReady ? repo.lastIngestedAt : null}
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
              {isFailed ? (
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
