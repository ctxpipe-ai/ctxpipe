import type {
  PendingConnectedGithubRepo,
  PendingSavedSetupRepo,
} from "./pendingGithubRepos"
import type { Repository } from "./types"

export type GitSourceListRow =
  | {
      kind: "pending-connected"
      key: string
      repo: PendingConnectedGithubRepo
    }
  | {
      kind: "pending-saved"
      key: string
      repo: PendingSavedSetupRepo
    }
  | {
      kind: "indexed"
      key: string
      repo: Repository
    }

/** Pending rows first, then indexed. */
export function buildGitSourceListRows({
  pendingConnected,
  pendingSaved,
  indexed,
}: {
  pendingConnected: PendingConnectedGithubRepo[]
  pendingSaved: PendingSavedSetupRepo[]
  indexed: Repository[]
}): GitSourceListRow[] {
  const rows: GitSourceListRow[] = []
  for (const repo of pendingConnected) {
    rows.push({
      kind: "pending-connected",
      key: `pending-connected:${repo.id}`,
      repo,
    })
  }
  for (const repo of pendingSaved) {
    rows.push({
      kind: "pending-saved",
      key: `pending-saved:${repo.gitUrl}`,
      repo,
    })
  }
  for (const repo of indexed) {
    rows.push({
      kind: "indexed",
      key: repo.id,
      repo,
    })
  }
  return rows
}
