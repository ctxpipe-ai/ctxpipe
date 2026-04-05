import {
  IconCheck,
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

  return (
    <div className="ctx-repo-row group">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="ctx-node h-10 w-10 shrink-0 transition-[color,background-color,border-color] duration-150 ease-out group-hover:border-teal-400 group-hover:bg-teal-400/5 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-muted-foreground [&_svg]:transition-colors group-hover:[&_svg]:text-teal-400">
          <IconGitBranch
            aria-hidden
            className="h-4 w-4 text-muted-foreground"
          />
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{repo.name}</p>
          <p
            className="truncate font-mono text-sm text-muted-foreground"
            title={repo.gitUrl}
          >
            {repo.gitUrl}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-4 sm:gap-6">
        {isDeleting ? (
          <span className="ctx-deleting hidden sm:inline-flex">
            <span aria-hidden className="ctx-deleting-dot" />
            deleting
          </span>
        ) : indexed ? (
          <div className="hidden items-center gap-1.5 text-primary sm:flex">
            <IconCheck aria-hidden className="h-3.5 w-3.5" />
            <span className="font-mono text-xs">indexed</span>
          </div>
        ) : (
          <span className="ctx-indexing hidden sm:inline-flex">
            <span aria-hidden className="ctx-indexing-dot" />
            indexing
          </span>
        )}

        <div className="sm:hidden">
          {isDeleting ? (
            <span className="ctx-deleting">
              <span aria-hidden className="ctx-deleting-dot" />
              deleting
            </span>
          ) : indexed ? (
            <span className="flex items-center gap-1 text-primary">
              <IconCheck aria-hidden className="h-3.5 w-3.5" />
              <span className="font-mono text-xs">indexed</span>
            </span>
          ) : (
            <span className="ctx-indexing">
              <span aria-hidden className="ctx-indexing-dot" />
              indexing
            </span>
          )}
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
              textValue="Remove repository"
              className="text-destructive"
            >
              <IconTrash aria-hidden className="h-4 w-4" />
              Remove
            </MenuItem>
          </Menu>
        </MenuTrigger>
      </div>
    </div>
  )
}
