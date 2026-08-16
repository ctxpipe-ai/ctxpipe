import { and, eq, inArray, sql } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import {
  CONNECTION_TYPE_LINEAR,
  CONNECTION_TYPE_NOTION,
  connections,
} from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"

type ConnectorSource = "confluence" | "notion"

type SyncTargetCandidate = {
  repositoryId: string
  repositoryName: string
  gitUrl: string
  branch: string
  githubConnectionId: string
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
    githubConnectionId: first.githubConnectionId,
    usedBy: [...new Set(candidates.map((row) => row.source))],
  }
}

export type ConnectorTargetRepository = {
  id: string
  gitUrl: string
  name: string
  createdAt: Date
  githubConnectionId: string | null
}

export async function listConnectorTargetRepositories(
  orgId: string,
): Promise<ConnectorTargetRepository[]> {
  const db = getSystemDb()
  const [confluenceTargets, connectionTargets] = await Promise.all([
    db
      .select({
        id: repositories.id,
        gitUrl: repositories.gitUrl,
        name: repositories.name,
        createdAt: repositories.createdAt,
        githubConnectionId: repositories.githubConnectionId,
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
        id: repositories.id,
        gitUrl: repositories.gitUrl,
        name: repositories.name,
        createdAt: repositories.createdAt,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(connections)
      .innerJoin(
        repositories,
        and(
          eq(repositories.orgId, connections.orgId),
          eq(repositories.id, sql`${connections.config}->>'repositoryId'`),
        ),
      )
      .where(
        and(
          eq(connections.orgId, orgId),
          eq(repositories.orgId, orgId),
          inArray(connections.type, [
            CONNECTION_TYPE_NOTION,
            CONNECTION_TYPE_LINEAR,
          ]),
          eq(sql`(${connections.config}->>'enabled')::boolean`, true),
        ),
      ),
  ])
  const byId = new Map<string, ConnectorTargetRepository>()
  for (const row of [...confluenceTargets, ...connectionTargets]) {
    if (!row.gitUrl.trim()) continue
    if (!byId.has(row.id)) byId.set(row.id, row)
  }
  return [...byId.values()]
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
        githubConnectionId: repositories.githubConnectionId,
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
        repositoryId: sql<string>`${connections.config}->>'repositoryId'`,
        repositoryName: repositories.name,
        gitUrl: repositories.gitUrl,
        branch: sql<string>`${connections.config}->>'branch'`,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(connections)
      .innerJoin(
        repositories,
        and(
          eq(repositories.orgId, connections.orgId),
          eq(repositories.id, sql`${connections.config}->>'repositoryId'`),
        ),
      )
      .where(
        and(
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
          eq(repositories.orgId, orgId),
          eq(sql`(${connections.config}->>'enabled')::boolean`, true),
        ),
      ),
  ])

  return chooseSuggestedConnectorSyncTarget([
    ...confluenceTargets.flatMap((target) =>
      target.githubConnectionId
        ? [
            {
              ...target,
              githubConnectionId: target.githubConnectionId,
              source: "confluence" as const,
            },
          ]
        : [],
    ),
    ...notionTargets.flatMap((target) =>
      target.githubConnectionId
        ? [
            {
              ...target,
              githubConnectionId: target.githubConnectionId,
              source: "notion" as const,
            },
          ]
        : [],
    ),
  ])
}
