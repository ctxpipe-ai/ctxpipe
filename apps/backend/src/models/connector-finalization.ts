import { and, eq } from "drizzle-orm"
import { getOrgDb } from "../db/client.js"
import { connections } from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { workspaces } from "../db/schema/workspaces.js"
import type { WorkspaceRevision } from "../domain/workspaces/revision.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"

export type CapturedConnectorBinding = {
  repositoryId: string
  revision: WorkspaceRevision
  provider:
    | { kind: "linear" | "notion"; workspaceId: string }
    | {
        kind: "confluence"
        cloudId: string
        atlassianApiBaseUrl: string | null
      }
}

/** Hold the captured target stable only for the final SQL projection. */
export async function lockConnectorFinalizationBinding(
  binding: CapturedConnectorBinding,
  connectionId: string,
): Promise<boolean> {
  const { revision } = binding
  const [row] = await getOrgDb()
    .select({
      workspace: workspaces,
      repository: repositories,
      connection: connections,
    })
    .from(workspaces)
    .innerJoin(
      repositories,
      and(
        eq(repositories.id, binding.repositoryId),
        eq(repositories.orgId, workspaces.orgId),
      ),
    )
    .innerJoin(
      connections,
      and(
        eq(connections.id, connectionId),
        eq(connections.orgId, workspaces.orgId),
      ),
    )
    .where(eq(workspaces.id, revision.workspaceId))
    .for("update")
  if (!row) return false
  const config = row.connection.config
  if (binding.provider.kind === "confluence") {
    if (
      row.connection.type !== "forge" ||
      config.cloudId !== binding.provider.cloudId ||
      (config.atlassianApiBaseUrl ?? null) !==
        binding.provider.atlassianApiBaseUrl ||
      ["revoked", "uninstalled"].includes(String(config.status))
    )
      return false
  } else if (
    row.connection.type !== binding.provider.kind ||
    config.workspaceId !== binding.provider.workspaceId ||
    (config.status ?? "installed") !== "installed"
  )
    return false
  return Boolean(
    row.workspace.desiredGeneration === revision.generation &&
      row.workspace.workspaceRepositoryUrl === revision.remote.url &&
      row.workspace.githubConnectionId === revision.remote.connectionId &&
      row.workspace.desiredDefaultBranch === revision.defaultBranch &&
      row.repository.githubConnectionId === revision.remote.connectionId &&
      normalizeWorkspaceRepositoryUrl(row.repository.gitUrl) ===
        normalizeWorkspaceRepositoryUrl(revision.remote.url),
  )
}
