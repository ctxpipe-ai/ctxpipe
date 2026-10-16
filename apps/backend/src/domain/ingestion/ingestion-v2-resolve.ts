import { and, eq } from "drizzle-orm"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { listOrgWorkspaces } from "../../models/workspaces.js"
import { githubSourceScopeRepositories } from "../workspace-sources/providers/github.js"
import { checkSourcePath } from "../workspace-sources/source-file.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../workspaces/write-status.js"
import type { IngestDestination } from "./ingest-shard-runtime.js"
import type { IngestionV2Input } from "./ingestion-run.js"

export type IngestionV2Resolution =
  | { skipped: "source_is_workspace" | "not_github" | "no_destination" }
  | {
      skipped?: undefined
      sourceRepositoryId: string | null
      destinations: IngestDestination[]
    }

/**
 * The `resolve` step (concept sections 2 and 4.1): the destination Workspaces
 * of the source, each with the binding generation and the default-branch
 * commit that the run pins. A destination is a Workspace with an `ok` GitHub
 * source file under `sources/` that names the source repository (ADR-050
 * revision 2026-10-16). The path of that file is the `sourcePath` of the
 * destination: each file that the run owns lists it in `sources`. An entry
 * of `.ctxpipe/sources.yaml` has no source path, so it makes no destination;
 * the conversion (CTX-744) gives the Workspace its source files. The run
 * skips a source that is the repository of a Workspace of the org. A
 * Workspace that is not writable, or has no commit yet, gets no refs.
 */
export async function resolveIngestionV2Run(
  input: Pick<IngestionV2Input, "orgId" | "source">,
): Promise<IngestionV2Resolution> {
  const sourceUrl = normalizeWorkspaceRepositoryUrl(input.source.url)
  const fullName = githubRepoFullNameFromWorkspaceUrl(sourceUrl)?.toLowerCase()
  if (!fullName) return { skipped: "not_github" }
  const orgWorkspaces = await withOrgDbContext(input.orgId, () =>
    listOrgWorkspaces(input.orgId),
  )
  if (
    orgWorkspaces.some(
      (row) =>
        normalizeWorkspaceRepositoryUrl(row.workspaceRepositoryUrl) ===
        sourceUrl,
    )
  )
    return { skipped: "source_is_workspace" }
  const [sourceRows, repositoryRows] = await withOrgDbContext(
    input.orgId,
    (db) =>
      Promise.all([
        db
          .select({
            workspaceId: workspaceSources.workspaceId,
            sourceKey: workspaceSources.sourceKey,
            scope: workspaceSources.scope,
          })
          .from(workspaceSources)
          .where(
            and(
              eq(workspaceSources.provider, "github"),
              eq(workspaceSources.status, "ok"),
            ),
          ),
        db
          .select({ id: repositories.id, gitUrl: repositories.gitUrl })
          .from(repositories),
      ]),
  )
  // The projection makes a second file of one repository invalid, so each
  // Workspace has at most one such row. Byte order keeps the choice stable.
  const sourcePaths = new Map<string, string>()
  for (const row of [...sourceRows].sort((a, b) =>
    a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0,
  )) {
    if (sourcePaths.has(row.workspaceId)) continue
    if (!checkSourcePath(row.sourceKey).ok) continue
    if (
      githubSourceScopeRepositories(row.scope).some(
        ({ name }) => name.toLowerCase() === fullName,
      )
    )
      sourcePaths.set(row.workspaceId, row.sourceKey)
  }
  const repositoryId = (url: string) =>
    repositoryRows.find(
      (row) =>
        normalizeWorkspaceRepositoryUrl(row.gitUrl) ===
        normalizeWorkspaceRepositoryUrl(url),
    )?.id ?? null
  const candidates = orgWorkspaces.flatMap((row) => {
    const sourcePath = sourcePaths.get(row.id)
    return sourcePath ? [{ row, sourcePath }] : []
  })
  if (!candidates.length) return { skipped: "no_destination" }
  const destinations: IngestDestination[] = candidates
    .flatMap(({ row, sourcePath }) =>
      row.writeStatus === "writable" && row.desiredSha && row.githubConnectionId
        ? [
            {
              workspaceId: row.id,
              url: row.workspaceRepositoryUrl,
              githubConnectionId: row.githubConnectionId,
              generation: row.desiredGeneration,
              pinnedRevision: row.desiredSha,
              repositoryId: repositoryId(row.workspaceRepositoryUrl),
              ...(row.rootPath ? { rootPath: row.rootPath } : {}),
              sourcePath,
            },
          ]
        : [],
    )
    .sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1))
  return {
    sourceRepositoryId: repositoryId(sourceUrl),
    destinations,
  }
}

/** The id and slug of the run's org; it throws when the org is gone. */
export async function ingestionOrg(
  orgId: string,
): Promise<{ id: string; slug: string }> {
  const [org] = await getSystemDb()
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  if (!org) throw new Error("The ingestion run's organization is gone")
  return org
}

/** Run `fn` in the org context that the Workspace models and the broker read. */
export async function withIngestionOrg<T>(
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withOrgIdContext(await ingestionOrg(orgId), fn)
}
