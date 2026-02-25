import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { formatDate } from "@/lib/format"
import type { Repository } from "../types"

export function RepositoryCard({ repo }: { repo: Repository }) {
  const status = repo.indexReady ? "Ready" : "Pending"
  const lastIndexed =
    repo.indexReady && repo.updatedAt ? formatDate(repo.updatedAt) : "—"
  const hashShort =
    repo.lastIngestedHash != null ? repo.lastIngestedHash.slice(0, 7) : null

  return (
    <Card className="border-zinc-800/90 bg-zinc-900/70 shadow-lg">
      <CardHeader>
        <CardTitle className="text-zinc-50">{repo.name}</CardTitle>
        <CardDescription
          className="font-mono text-xs text-zinc-400 truncate"
          title={repo.gitUrl}
        >
          {repo.gitUrl}
        </CardDescription>
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
