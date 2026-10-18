import { and, eq } from "drizzle-orm"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { listOrgWorkspaces } from "../../models/workspaces.js"
import {
  PlainGitUrlError,
  resolvePlainGitRemote,
} from "../../services/git/plain-git-remote.js"
import { repositorySourcePaths } from "../workspace-sources/github-sources.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import type { IngestDestination } from "./ingest-shard-runtime.js"
import type { IngestionV2Input } from "./ingestion-run.js"
import { ingestionV2EnabledFor } from "./ingestion-v2-config.js"

export type IngestionV2Resolution =
  | {
      skipped:
        | "source_is_workspace"
        | "no_destination"
        // A plain git URL that the DNS check refuses (CTX-815).
        | "refused_url"
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
 * commit that the run pins. A destination is a Workspace with an `ok` source
 * file under `sources/` that names the source repository (ADR-050 revision
 * 2026-10-16): a GitHub source file for a GitHub source, and a plain git
 * source file (`sources/git/...`, CTX-815) for a plain git source. The path of that file is the `sourcePath` of the
 * destination: each file that the run owns lists it in `sources`. An entry
 * of `.ctxpipe/sources.yaml` has no source path, so it makes no destination;
 * the conversion (CTX-744) gives the Workspace its source files. The run
 * skips a source that is the repository of a Workspace of the org. A
 * Workspace that is not writable, or has no commit yet, gets no refs. When
 * the input has `destinations`, only those Workspaces can be destinations.
 */
export async function resolveIngestionV2Run(
  input: Pick<IngestionV2Input, "orgId" | "source" | "shadow" | "destinations">,
): Promise<IngestionV2Resolution> {
  const sourceUrl = normalizeWorkspaceRepositoryUrl(input.source.url)
  // A GitHub source needs a GitHub source file, and a plain git source a
  // plain git source file: a GitHub source file gives a connection that a
  // plain git run never uses.
  const provider = input.source.kind === "git" ? "git" : "github"
  // A plain git host must resolve only to public addresses before any read
  // of the run: the codesearch index, the host source tree, or the sandbox.
  if (input.source.kind === "git") {
    const refused = await resolvePlainGitRemote(input.source.url).then(
      () => false,
      (error: unknown) => {
        if (error instanceof PlainGitUrlError) return true
        throw error
      },
    )
    if (refused) return { skipped: "refused_url" }
  }
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
            provider: workspaceSources.provider,
            status: workspaceSources.status,
            scope: workspaceSources.scope,
          })
          .from(workspaceSources)
          .where(
            and(
              eq(workspaceSources.provider, provider),
              eq(workspaceSources.status, "ok"),
            ),
          ),
        db
          .select({ id: repositories.id, gitUrl: repositories.gitUrl })
          .from(repositories),
      ]),
  )
  const sourcePath = (workspaceId: string) =>
    repositorySourcePaths(
      sourceRows.filter((row) => row.workspaceId === workspaceId),
    ).get(sourceUrl)
  const repositoryId = (url: string) =>
    repositoryRows.find(
      (row) =>
        normalizeWorkspaceRepositoryUrl(row.gitUrl) ===
        normalizeWorkspaceRepositoryUrl(url),
    )?.id ?? null
  const declared = orgWorkspaces.flatMap((row) => {
    if (input.destinations && !input.destinations.includes(row.id)) return []
    const path = sourcePath(row.id)
    return path ? [{ row, sourcePath: path }] : []
  })
  if (!declared.length) return { skipped: "no_destination" }
  // A publish run writes ownership front matter (format 3). A Workspace
  // below it waits for the upgrade; a shadow run publishes nothing, so it
  // runs for each Workspace.
  const needsUpgrade = input.shadow
    ? []
    : declared.filter(({ row }) => !ingestionV2EnabledFor(row))
  if (needsUpgrade.length === declared.length)
    return { skipped: "upgrade_needed" }
  const candidates = declared.filter((entry) => !needsUpgrade.includes(entry))
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
    needsUpgrade: needsUpgrade.map(({ row }) => row.id),
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
