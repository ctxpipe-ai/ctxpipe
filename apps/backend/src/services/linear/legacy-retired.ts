import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import { listConnectionSourceRows } from "../../models/workspace-sources.js"

type ConnectionSourceRow = Awaited<
  ReturnType<typeof listConnectionSourceRows>
>[number]

/**
 * Whether the Workspace sources sync owns the old sync repository of a
 * Linear connection: an `ok` Linear source of the connection lives in a
 * Workspace whose repository is that repository. Then the legacy mirror
 * (ADR-022) must not run, because its full capture and its prune delete the
 * files that the sources sync writes under `linear/teams/` and
 * `linear/projects/`.
 */
export function linearLegacyRetiredBy(
  sources: readonly ConnectionSourceRow[],
  syncRepositoryGitUrl: string,
): boolean {
  const target = normalizeWorkspaceRepositoryUrl(syncRepositoryGitUrl)
  return sources.some(
    (row) =>
      row.source.provider === "linear" &&
      row.source.status === "ok" &&
      normalizeWorkspaceRepositoryUrl(row.workspaceRepositoryUrl) === target,
  )
}

export async function linearLegacySyncRetired(input: {
  orgId: string
  connectionId: string
  syncRepositoryGitUrl: string
}): Promise<boolean> {
  return linearLegacyRetiredBy(
    await listConnectionSourceRows({
      orgId: input.orgId,
      connectionId: input.connectionId,
      status: "ok",
    }),
    input.syncRepositoryGitUrl,
  )
}
