/**
 * The Workspace knowledge units one repository's extraction wrote, read at the
 * Workspace's published projection. Used by `repoGraphSizeCheck` and the
 * ingestion validator. Call inside `withOrgIdContext`.
 */
import { and, desc, eq, sql } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import { workspaceWriteJobs } from "../db/schema/workspaces.js"
import {
  type ProjectionState,
  type PublishedProjection,
  publishedProjection,
} from "../domain/workspaces/revision.js"
import { getWorkspaceProjectionSnapshot } from "./workspaces.js"

export type ExtractWriteJob = {
  id: string
  status: string
  commitSha: string | null
  /** Exported object key → knowledge file path written by this extraction. */
  knowledgePaths: Record<string, string>
}

/**
 * One extraction write job: by id, or the latest completed one for a
 * repository in a Workspace.
 */
export async function readExtractWriteJob(
  orgId: string,
  target: { jobId: string } | { workspaceId: string; repositoryId: string },
): Promise<ExtractWriteJob | null> {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({
        id: workspaceWriteJobs.id,
        status: workspaceWriteJobs.status,
        commitSha: workspaceWriteJobs.commitSha,
        knowledgePaths: sql<Record<
          string,
          string
        > | null>`${workspaceWriteJobs.payload}->'knowledgePaths'`,
      })
      .from(workspaceWriteJobs)
      .where(
        "jobId" in target
          ? and(
              eq(workspaceWriteJobs.orgId, orgId),
              eq(workspaceWriteJobs.id, target.jobId),
            )
          : and(
              eq(workspaceWriteJobs.orgId, orgId),
              eq(workspaceWriteJobs.workspaceId, target.workspaceId),
              eq(workspaceWriteJobs.kind, "extract_ingest"),
              eq(workspaceWriteJobs.status, "completed"),
              sql`${workspaceWriteJobs.payload}->'extraction'->>'repositoryId' = ${target.repositoryId}`,
            ),
      )
      .orderBy(desc(workspaceWriteJobs.updatedAt))
      .limit(1),
  )
  return row ? { ...row, knowledgePaths: row.knowledgePaths ?? {} } : null
}

type SnapshotUnit = Awaited<
  ReturnType<typeof getWorkspaceProjectionSnapshot>
>["units"][number]

export type RepositoryUnits = {
  projection: ProjectionState
  published: PublishedProjection | null
  /** SHA the Workspace serves; units below are read at it. */
  projectionSha: string | null
  /** The repository's units: those at an extraction knowledge path. */
  units: SnapshotUnit[]
  /** Every unit of the Workspace at the same SHA. */
  workspaceUnits: SnapshotUnit[]
}

export async function readRepositoryUnits(
  workspaceId: string,
  knowledgePaths: readonly string[],
): Promise<RepositoryUnits> {
  const snapshot = await getWorkspaceProjectionSnapshot(workspaceId)
  const published = publishedProjection(snapshot.projection)
  const projectionSha = published
    ? published.kind === "active"
      ? published.revision.sha
      : published.sha
    : null
  const workspaceUnits = snapshot.units.filter(
    (unit) => unit.projectionSha === projectionSha,
  )
  const wanted = new Set(knowledgePaths)
  return {
    projection: snapshot.projection,
    published,
    projectionSha,
    units: workspaceUnits.filter((unit) => wanted.has(unit.path)),
    workspaceUnits,
  }
}

/** Units per front-matter kind (`(none)` for plain knowledge files). */
export function unitKinds(
  units: ReadonlyArray<{ kind?: string | null }>,
): Record<string, number> {
  const kinds: Record<string, number> = {}
  for (const unit of units) {
    const kind = unit.kind ?? "(none)"
    kinds[kind] = (kinds[kind] ?? 0) + 1
  }
  return kinds
}
