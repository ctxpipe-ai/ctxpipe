import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/Button"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { IconDotsVertical, IconTrash } from "@tabler/icons-react"
import { formatDate } from "@/lib/format"
import type { Repository } from "../types"

export function RepositoryCard({
  repo,
  onDelete,
}: {
  repo: Repository
  onDelete: (repo: Repository) => void
}) {
  const status = repo.indexReady ? "Ready" : "Pending"
  const lastIndexed =
    repo.indexReady && repo.updatedAt ? formatDate(repo.updatedAt) : "—"
  const hashShort =
    repo.lastIngestedHash != null ? repo.lastIngestedHash.slice(0, 7) : null

  return (
    <Card className="border-zinc-800/90 bg-zinc-900/70 shadow-lg relative">
      <CardHeader>
        <CardTitle className="text-zinc-50 truncate">{repo.name}</CardTitle>
        <CardDescription
          className="font-mono text-xs text-zinc-400 truncate"
          title={repo.gitUrl}
        >
          {repo.gitUrl}
        </CardDescription>
        <CardAction>
          <MenuTrigger placement="bottom end">
            <Button
              variant="quiet"
              aria-label="More options"
              className="text-zinc-400"
            >
              <IconDotsVertical className="w-4 h-4" />
            </Button>
            <Menu onAction={(key) => key === "delete" && onDelete(repo)}>
              <MenuItem
                key="delete"
                textValue="Delete"
                className="text-red-400"
              >
                <IconTrash className="w-4 h-4" />
                Delete
              </MenuItem>
            </Menu>
          </MenuTrigger>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-zinc-500">Index status</span>
          <span
            className={repo.indexReady ? "text-emerald-400" : "text-amber-400"}
          >
            {status}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-zinc-500">Last indexed</span>
          <span className="text-zinc-300" title={repo.updatedAt}>
            {lastIndexed}
          </span>
        </div>
        {hashShort != null && (
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">Commit</span>
            <span
              className="font-mono text-zinc-400"
              title={repo.lastIngestedHash ?? undefined}
            >
              {hashShort}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-zinc-500">Created</span>
          <span className="text-zinc-400" title={repo.createdAt}>
            {formatDate(repo.createdAt)}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
