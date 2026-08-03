import { and, eq } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { notionSyncTargets } from "../db/schema/notionSyncTargets.js"
import { repositories } from "../db/schema/repositories.js"

type ConnectorSource = "confluence" | "notion"

type SyncTargetCandidate = {
  repositoryId: string
  repositoryName: string
  gitUrl: string
  branch: string
  source: ConnectorSource
}

export type SuggestedConnectorSyncTarget = Omit<
  SyncTargetCandidate,
  "source"
> & {
  usedBy: ConnectorSource[]
}

export function chooseSuggestedConnectorSyncTarget(
  candidates: SyncTargetCandidate[],
): SuggestedConnectorSyncTarget | null {
  const repositoryIds = new Set(candidates.map((row) => row.repositoryId))
  const branches = new Set(candidates.map((row) => row.branch))
  if (repositoryIds.size !== 1 || branches.size !== 1) return null

  const first = candidates[0]
  if (!first) return null
  return {
    repositoryId: first.repositoryId,
    repositoryName: first.repositoryName,
    gitUrl: first.gitUrl,
    branch: first.branch,
    usedBy: [...new Set(candidates.map((row) => row.source))],
  }
}

export async function getSuggestedConnectorSyncTarget(
  orgId: string,
): Promise<SuggestedConnectorSyncTarget | null> {
  const db = getSystemDb()
  const [confluenceTargets, notionTargets] = await Promise.all([
    db
      .select({
        repositoryId: confluenceSyncTargets.repositoryId,
        repositoryName: repositories.name,
        gitUrl: repositories.gitUrl,
        branch: confluenceSyncTargets.branch,
      })
      .from(confluenceSyncTargets)
      .innerJoin(
        repositories,
        eq(confluenceSyncTargets.repositoryId, repositories.id),
      )
      .where(
        and(
          eq(confluenceSyncTargets.orgId, orgId),
          eq(repositories.orgId, orgId),
          eq(confluenceSyncTargets.enabled, true),
        ),
      ),
    db
      .select({
        repositoryId: notionSyncTargets.repositoryId,
        repositoryName: repositories.name,
        gitUrl: repositories.gitUrl,
        branch: notionSyncTargets.branch,
      })
      .from(notionSyncTargets)
      .innerJoin(
        repositories,
        eq(notionSyncTargets.repositoryId, repositories.id),
      )
      .where(
        and(
          eq(notionSyncTargets.orgId, orgId),
          eq(repositories.orgId, orgId),
          eq(notionSyncTargets.enabled, true),
        ),
      ),
  ])

  return chooseSuggestedConnectorSyncTarget([
    ...confluenceTargets.map((target) => ({
      ...target,
      source: "confluence" as const,
    })),
    ...notionTargets.map((target) => ({
      ...target,
      source: "notion" as const,
    })),
  ])
}
