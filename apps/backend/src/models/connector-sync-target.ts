import { and, eq, inArray, sql } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import {
  CONNECTION_TYPE_LINEAR,
  CONNECTION_TYPE_NOTION,
  CONNECTION_TYPE_SLACK,
  connections,
} from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"

export type ConnectorSource = "confluence" | "notion" | "linear" | "slack"

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

const GIT_NATIVE_CONNECTOR_TYPES = [
  CONNECTION_TYPE_NOTION,
  CONNECTION_TYPE_LINEAR,
  CONNECTION_TYPE_SLACK,
] as const

function sourceForConnectionType(
  type: (typeof GIT_NATIVE_CONNECTOR_TYPES)[number],
): Exclude<ConnectorSource, "confluence"> {
  if (type === CONNECTION_TYPE_LINEAR) return "linear"
  if (type === CONNECTION_TYPE_SLACK) return "slack"
  return "notion"
}

/** Suggest the target only when every bound connector agrees on it. */
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

export async function getSuggestedConnectorSyncTarget(
  orgId: string,
): Promise<SuggestedConnectorSyncTarget | null> {
  return withOrgDbContext(orgId, async () => {
    const db = getOrgDb()
    const [confluenceTargets, connectionTargets] = await Promise.all([
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
          type: connections.type,
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
            inArray(connections.type, [...GIT_NATIVE_CONNECTOR_TYPES]),
            eq(repositories.orgId, orgId),
            sql`coalesce(${connections.config}->>'repositoryId', '') <> ''`,
            sql`coalesce(${connections.config}->>'enabled', 'true') = 'true'`,
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
      ...connectionTargets.flatMap((target) => {
        if (!target.githubConnectionId) return []
        if (
          target.type !== CONNECTION_TYPE_NOTION &&
          target.type !== CONNECTION_TYPE_LINEAR &&
          target.type !== CONNECTION_TYPE_SLACK
        ) {
          return []
        }
        return [
          {
            repositoryId: target.repositoryId,
            repositoryName: target.repositoryName,
            gitUrl: target.gitUrl,
            branch: target.branch,
            githubConnectionId: target.githubConnectionId,
            source: sourceForConnectionType(target.type),
          },
        ]
      }),
    ])
  })
}
