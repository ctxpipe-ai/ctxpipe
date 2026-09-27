import { and, eq, inArray, sql } from "drizzle-orm"
import { getOrgDb, getSystemDb } from "../db/client.js"
import {
  CONNECTION_TYPE_LINEAR,
  CONNECTION_TYPE_NOTION,
  CONNECTION_TYPE_SLACK,
  connections,
} from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  pickGithubPrMirrorTarget,
  type GithubPrMirrorTargetCandidate,
  isCtxpipeContextRepositoryName,
} from "../services/github/pull-request-mirror/source-scope.js"
import { getGithubPrMirrorBinding } from "./github-pr-mirror.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

const CONNECTOR_TYPES = [
  CONNECTION_TYPE_LINEAR,
  CONNECTION_TYPE_NOTION,
  CONNECTION_TYPE_SLACK,
] as const

function asCandidate(
  row: {
    id: string
    name: string
    githubConnectionId: string | null
    branch: string | null
  },
  githubConnectionId: string,
): GithubPrMirrorTargetCandidate | null {
  if (row.githubConnectionId !== githubConnectionId) return null
  return {
    repositoryId: row.id,
    repositoryName: row.name,
    branch: row.branch?.trim() || "main",
  }
}

export async function resolveGithubPrMirrorTarget(input: {
  orgId: string
  connectionId: string
}): Promise<GithubPrMirrorTargetCandidate | null> {
  const existing = await getGithubPrMirrorBinding(input.orgId, input.connectionId)
  const existingCandidate = existing
    ? {
        repositoryId: existing.repositoryId,
        repositoryName: existing.repositoryName,
        branch: existing.branch,
      }
    : null

  const db = getSystemDb()
  const connectorRows = await db
    .select({
      repositoryId: sql<string>`${connections.config}->>'repositoryId'`,
      branch: sql<string | null>`${connections.config}->>'branch'`,
    })
    .from(connections)
    .where(
      and(
        eq(connections.orgId, input.orgId),
        inArray(connections.type, [...CONNECTOR_TYPES]),
        sql`coalesce(${connections.config}->>'repositoryId', '') <> ''`,
      ),
    )

  const orgDb = getOrgDb()
  const connectorIds = [
    ...new Set(connectorRows.map((row) => row.repositoryId).filter(Boolean)),
  ]
  const connectorRepos =
    connectorIds.length === 0
      ? []
      : await orgDb
          .select({
            id: repositories.id,
            name: repositories.name,
            githubConnectionId: repositories.githubConnectionId,
            branch: repositoryCheckouts.ref,
          })
          .from(repositories)
          .leftJoin(
            repositoryCheckouts,
            and(
              eq(repositoryCheckouts.repositoryId, repositories.id),
              eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
            ),
          )
          .where(
            and(
              eq(repositories.orgId, input.orgId),
              inArray(repositories.id, connectorIds),
            ),
          )

  const connectorTargets = connectorRepos.flatMap((row) => {
    const override = connectorRows.find(
      (candidate) => candidate.repositoryId === row.id,
    )
    const candidate = asCandidate(
      {
        ...row,
        branch: override?.branch ?? row.branch,
      },
      input.connectionId,
    )
    return candidate ? [candidate] : []
  })

  const contextRepos = (
    await orgDb
      .select({
        id: repositories.id,
        name: repositories.name,
        githubConnectionId: repositories.githubConnectionId,
        branch: repositoryCheckouts.ref,
      })
      .from(repositories)
      .leftJoin(
        repositoryCheckouts,
        and(
          eq(repositoryCheckouts.repositoryId, repositories.id),
          eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
        ),
      )
      .where(
        and(
          eq(repositories.orgId, input.orgId),
          eq(repositories.githubConnectionId, input.connectionId),
        ),
      )
  ).flatMap((row) => {
    if (!isCtxpipeContextRepositoryName(row.name)) return []
    const candidate = asCandidate(row, input.connectionId)
    return candidate ? [candidate] : []
  })

  return pickGithubPrMirrorTarget({
    existing: existingCandidate,
    connectorTargets,
    ctxpipeContextRepos: contextRepos,
  })
}
