import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card"
import { Button } from "@/components/ui/Button"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { IconDotsVertical, IconTrash } from "@tabler/icons-react"
import { formatDate } from "@/lib/format"
import type { Repository } from "../types"

interface RepositoryCardProps {
  repo: Repository
  onDelete: (repo: Repository) => void
}

export function RepositoryCard({ repo, onDelete }: RepositoryCardProps) {
  const status = repo.indexReady ? "Ready" : "Pending"
  const lastIndexed =
    repo.indexReady && repo.updatedAt ? formatDate(repo.updatedAt) : "—"
  const hashShort =
    repo.lastIngestedHash != null ? repo.lastIngestedHash.slice(0, 7) : null

  const statusClass = repo.indexReady ? "text-emerald-400" : "text-amber-400"

  return (
    <Card
      className="border-zinc-800/90 bg-zinc-900/70 shadow-lg relative"
      size="sm"
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="flex-1 min-w-0">
          <div className="text-zinc-50 font-medium truncate">{repo.name}</div>
          <div
            className="font-mono text-xs text-zinc-400 truncate"
            title={repo.gitUrl}
          >
            {repo.gitUrl}
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">Status</span>
            <span className={statusClass}>{status}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">Last indexed</span>
            <span className="text-zinc-300" title={repo.updatedAt}>
              {lastIndexed}
            </span>
          </div>
          {hashShort != null && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">Commit</span>
              <span
                className="font-mono text-zinc-400"
                title={repo.lastIngestedHash ?? undefined}
              >
                {hashShort}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className={`sm:hidden text-sm ${statusClass}`}>{status}</span>
          <MenuTrigger placement="bottom end">
            <Button
              variant="quiet"
              aria-label="More options"
              className="text-zinc-400"
            >
              <IconDotsVertical className="w-4 h-4" />
            </Button>
            <Menu onAction={(key) => key === "delete" && onDelete(repo)}>
              <MenuItem id="delete" textValue="Delete" className="text-red-400">
                <IconTrash className="w-4 h-4" />
                Delete
              </MenuItem>
            </Menu>
          </MenuTrigger>
        </div>
      </div>
    </Card>
  )
}
