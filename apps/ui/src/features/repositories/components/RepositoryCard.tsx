import {
  IconDots,
  IconExternalLink,
  IconGitBranch,
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
import { RepositoryStatus, type RepositoryStatusState } from "./RepositoryStatus"
import type { Repository } from "../types"

interface RepositoryCardProps {
  repo: Repository
  onDelete: (repo: Repository) => void
  isDeleting?: boolean
}

export function RepositoryCard({
  repo,
  onDelete,
  isDeleting = false,
}: RepositoryCardProps) {
  const webUrl = githubWebUrl(repo.gitUrl)
  const indexed = repo.indexReady
  const status: RepositoryStatusState = isDeleting
    ? "deleting"
    : indexed
      ? "indexed"
      : "indexing"

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
        <RepositoryStatus status={status} className="hidden sm:inline-flex" />

        <div className="sm:hidden">
          <RepositoryStatus status={status} />
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
            isDisabled={isDeleting}
          >
            <IconDots className="h-4 w-4" />
          </Button>
          <Menu
            onAction={(key) => {
              if (key === "delete") onDelete(repo)
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
