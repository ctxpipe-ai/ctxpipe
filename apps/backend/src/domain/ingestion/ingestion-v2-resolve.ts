import { and, eq } from "drizzle-orm"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { listOrgWorkspaces } from "../../models/workspaces.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import {
  formatBelow,
  INGESTION_V2_PUBLISH_FORMAT,
} from "../workspaces/workspace-format.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../workspaces/write-status.js"
import type { IngestDestination } from "./ingest-shard-runtime.js"
import type { IngestionV2Input } from "./ingestion-run.js"

export type IngestionV2Resolution =
  | {
      skipped:
        | "source_is_workspace"
        | "not_github"
        | "no_destination"
        // Each destination is below format 3: the run publishes nothing.
        | "upgrade_needed"
    }
  | {
      skipped?: undefined
      sourceRepositoryId: string | null
      destinations: IngestDestination[]
      /** Destinations that a publish run left out: below format 3. Empty in shadow mode. */
      needsUpgrade: string[]
    }

/**
 * The `resolve` step (concept sections 2 and 4.1): the destination Workspaces
 * of the source, each with the binding generation and the default-branch
 * commit that the run pins. A destination is a Workspace whose
 * `.ctxpipe/sources.yaml` declares the source repository (a valid GitHub
 * entry). The run skips a source that is the repository of a Workspace of the
 * org. A Workspace that is not writable, or has no commit yet, gets no refs.
 */
export async function resolveIngestionV2Run(
  input: Pick<IngestionV2Input, "orgId" | "source" | "shadow">,
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
  const declaring = new Set(
    sourceRows
      .filter((row) => {
        const names = (row.scope as { repositories?: unknown }).repositories
        return (
          Array.isArray(names) &&
          names.some(
            (name) =>
              typeof name === "string" && name.toLowerCase() === fullName,
          )
        )
      })
      .map((row) => row.workspaceId),
  )
  const repositoryId = (url: string) =>
    repositoryRows.find(
      (row) =>
        normalizeWorkspaceRepositoryUrl(row.gitUrl) ===
        normalizeWorkspaceRepositoryUrl(url),
    )?.id ?? null
  const declared = orgWorkspaces.filter((row) => declaring.has(row.id))
  if (!declared.length) return { skipped: "no_destination" }
  // A publish run writes ownership front matter (format 3). A Workspace
  // below it waits for the upgrade; a shadow run publishes nothing, so it
  // runs for each Workspace.
  const needsUpgrade = input.shadow
    ? []
    : declared.filter((row) =>
        formatBelow(row.formatVersion, INGESTION_V2_PUBLISH_FORMAT),
      )
  if (needsUpgrade.length === declared.length)
    return { skipped: "upgrade_needed" }
  const candidates = declared.filter((row) => !needsUpgrade.includes(row))
  const destinations: IngestDestination[] = candidates
    .flatMap((row) =>
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
            },
          ]
        : [],
    )
    .sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1))
  return {
    sourceRepositoryId: repositoryId(sourceUrl),
    destinations,
    needsUpgrade: needsUpgrade.map((row) => row.id),
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
