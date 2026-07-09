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
import { getRepositoryIndexingStatus } from "@/features/repositories/types"
import { RepositoryStatus, type RepositoryStatusState } from "./RepositoryStatus"
import type { Repository } from "../types"

interface RepositoryCardProps {
  repo: Repository
  onDelete: (repo: Repository) => void
  onRetry: (repo: Repository) => void
  isRetrying?: boolean
  isDeleting?: boolean
}

export function RepositoryCard({
  repo,
  onDelete,
  onRetry,
  isRetrying = false,
  isDeleting = false,
}: RepositoryCardProps) {
  const webUrl = githubWebUrl(repo.gitUrl)
  const indexingStatus = getRepositoryIndexingStatus(repo)
  const indexed = indexingStatus === "ready"
  const failed = indexingStatus === "failed"
  const status: RepositoryStatusState = isDeleting
    ? "deleting"
    : failed
      ? "failed"
      : indexed
      ? "indexed"
      : "indexing"

  const indexingDetail =
    !indexed && repo.indexingReason === "merge"
      ? "indexing merge"
      : !indexed && repo.indexingReason === "push"
        ? "indexing recent changes"
        : null
  const failedDetail = failed
    ? repo.indexingError?.trim() || "indexing failed"
    : null

  return (
    <div className="ctx-repo-row group">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div
          className={`ctx-node h-10 w-10 shrink-0 transition-[color,background-color,border-color] duration-150 ease-out [&_svg]:h-4 [&_svg]:w-4 [&_svg]:transition-colors ${
            indexed
              ? "border-teal-400 bg-teal-400/5 [&_svg]:text-teal-400"
              : "group-hover:border-teal-400 group-hover:bg-teal-400/5 [&_svg]:text-muted-foreground group-hover:[&_svg]:text-teal-400"
          }`}
        >
          <IconGitBranch
            aria-hidden
            className={`h-4 w-4 ${indexed ? "text-teal-400" : "text-muted-foreground"}`}
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
          status={status}
          indexingDetail={indexingDetail}
          failedDetail={failedDetail}
          className="hidden sm:inline-flex"
        />

        <div className="sm:hidden">
          <RepositoryStatus
            status={status}
            indexingDetail={indexingDetail}
            failedDetail={failedDetail}
          />
        </div>

        <MenuTrigger
          placement="bottom end"
          popoverClassName="rounded-none border-border bg-card"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-none"
            aria-label="Repository actions"
            isDisabled={isDeleting || isRetrying}
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
            {failed ? (
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
              textValue="Unindex repository"
              className="text-destructive"
            >
              <IconTrash aria-hidden className="h-4 w-4" />
              Unindex
            </MenuItem>
          </Menu>
        </MenuTrigger>
      </div>
    </div>
  )
}
