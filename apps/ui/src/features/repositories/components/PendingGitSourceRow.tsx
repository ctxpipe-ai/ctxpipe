import { IconDots, IconGitBranch } from "@tabler/icons-react"
import { Button } from "@/components/ui/Button"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { RepositoryStatus } from "./RepositoryStatus"

export function PendingGitSourceRow({
  title,
  subtitle,
  href,
  onIndexNow,
  isIndexing,
  interactive = true,
}: {
  title: string
  subtitle: string
  href?: string
  onIndexNow: () => void
  isIndexing: boolean
  interactive?: boolean
}) {
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
          <p className="truncate text-sm text-foreground">{title}</p>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="truncate text-xs text-muted-foreground hover:text-foreground"
            >
              {href}
            </a>
          ) : (
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-4 sm:gap-6">
        <RepositoryStatus status="pending-indexing" interactive={interactive} />
        {interactive ? (
          <MenuTrigger
            placement="bottom end"
            popoverClassName="rounded-none border-border bg-card"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-none"
              aria-label="Pending repository actions"
              isDisabled={isIndexing}
            >
              <IconDots className="h-4 w-4" />
            </Button>
            <Menu>
              <MenuItem
                onAction={onIndexNow}
                textValue="Index now"
                className="rounded-none text-zinc-100 hover:bg-zinc-800 focus:bg-zinc-800"
              >
                Index now
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
