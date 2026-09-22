import { and, eq, inArray, sql } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import {
  CONNECTION_TYPE_GITHUB,
  CONNECTION_TYPE_LINEAR,
  CONNECTION_TYPE_NOTION,
  CONNECTION_TYPE_SLACK,
  connections,
} from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { isCtxpipeContextRepositoryName } from "../services/github/pull-request-mirror/source-scope.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

export type ConnectorSource =
  | "confluence"
  | "notion"
  | "linear"
  | "slack"
  | "github"

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
): Exclude<ConnectorSource, "confluence" | "github"> {
  if (type === CONNECTION_TYPE_LINEAR) return "linear"
  if (type === CONNECTION_TYPE_SLACK) return "slack"
  return "notion"
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

export function suggestConnectorSyncTarget(input: {
  connectorCandidates: SyncTargetCandidate[]
  ctxpipeContextRepos: Array<Omit<SyncTargetCandidate, "source">>
}): SuggestedConnectorSyncTarget | null {
  if (input.connectorCandidates.length > 0) {
    return chooseSuggestedConnectorSyncTarget(input.connectorCandidates)
  }
  const context = input.ctxpipeContextRepos[0]
  if (!context) return null
  return {
    ...context,
    usedBy: ["github"],
  }
}

export async function getSuggestedConnectorSyncTarget(
  orgId: string,
): Promise<SuggestedConnectorSyncTarget | null> {
  const db = getSystemDb()
  const [confluenceTargets, connectionTargets, githubTargets, contextRows] =
    await Promise.all([
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
      db
        .select({
          repositoryId: sql<string>`${connections.config}->'prMirror'->>'repositoryId'`,
          repositoryName: repositories.name,
          gitUrl: repositories.gitUrl,
          branch: sql<
            string | null
          >`${connections.config}->'prMirror'->>'branch'`,
          githubConnectionId: repositories.githubConnectionId,
        })
        .from(connections)
        .innerJoin(
          repositories,
          and(
            eq(repositories.orgId, connections.orgId),
            eq(
              repositories.id,
              sql`${connections.config}->'prMirror'->>'repositoryId'`,
            ),
          ),
        )
        .where(
          and(
            eq(connections.orgId, orgId),
            eq(connections.type, CONNECTION_TYPE_GITHUB),
            eq(repositories.orgId, orgId),
            sql`coalesce(${connections.config}->'prMirror'->>'repositoryId', '') <> ''`,
            sql`coalesce(${connections.config}->'prMirror'->>'enabled', 'true') = 'true'`,
          ),
        ),
      db
        .select({
          repositoryId: repositories.id,
          repositoryName: repositories.name,
          gitUrl: repositories.gitUrl,
          branch: repositoryCheckouts.ref,
          githubConnectionId: repositories.githubConnectionId,
        })
        .from(repositories)
        .leftJoin(
          repositoryCheckouts,
          and(
            eq(repositoryCheckouts.repositoryId, repositories.id),
            eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
          ),
        )
        .where(eq(repositories.orgId, orgId)),
    ])

  const connectorCandidates: SyncTargetCandidate[] = [
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
    ...githubTargets.flatMap((target) =>
      target.githubConnectionId
        ? [
            {
              repositoryId: target.repositoryId,
              repositoryName: target.repositoryName,
              gitUrl: target.gitUrl,
              branch: target.branch?.trim() || "main",
              githubConnectionId: target.githubConnectionId,
              source: "github" as const,
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
  ]

  const ctxpipeContextRepos = contextRows.flatMap((row) => {
    if (!row.githubConnectionId) return []
    if (!isCtxpipeContextRepositoryName(row.repositoryName)) return []
    return [
      {
        repositoryId: row.repositoryId,
        repositoryName: row.repositoryName,
        gitUrl: row.gitUrl,
        branch: row.branch?.trim() || "main",
        githubConnectionId: row.githubConnectionId,
      },
    ]
  })

  return suggestConnectorSyncTarget({
    connectorCandidates,
    ctxpipeContextRepos,
  })
}
