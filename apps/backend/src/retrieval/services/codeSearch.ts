import { and, eq, inArray } from "drizzle-orm"
import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import {
  codesearchMembershipGitUrls,
  workspaceCheckoutKey,
} from "../../domain/workspaces/derived-stores.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
import { withTransientHttpRetry } from "../../lib/withTransientHttpRetry.js"
import { DEFAULT_CHECKOUT_KEY } from "../../models/repositories.js"
import {
  getWorkspaceById,
  listLinkedRepositories,
} from "../../models/workspaces.js"

export type CodeSearchResult = {
  repositoryId: string
  repositoryName: string
  zoektRepoId: number
  query: string
  response: Record<string, unknown>
}

/** Parsed code candidate for merge. Repo-level or file-level. */
export type ParsedCodeCandidate = {
  objectId: string
  repositoryId: string
  repositoryName?: string
  path?: string
  query?: string
  response?: unknown
  score?: number
  lineMatchCount?: number
}

type ZoektFileMatch = {
  FileName?: string
  Repository?: string
  RepositoryID?: number
  Score?: number
  LineMatches?: unknown[]
}

/**
 * Parses Zoekt response into repo-level and file-level candidates.
 * Repo-level: one per repo with matches (objectId = repositoryId).
 * File-level: one per file with matches (objectId = file:repoId:path).
 */
export function parseCodeSearchResults(
  results: CodeSearchResult[],
): ParsedCodeCandidate[] {
  if (results.length === 0) return []
  const byRepoId = new Map(results.map((r) => [r.repositoryId, r]))
  const byZoektId = new Map(results.map((r) => [r.zoektRepoId, r]))
  const byName = new Map(results.map((r) => [r.repositoryName, r]))
  const first = results[0]
  if (!first) return []
  const response = first.response as { Files?: ZoektFileMatch[] } | undefined
  const files = response?.Files ?? []
  const query = first.query ?? ""
  const candidates: ParsedCodeCandidate[] = []
  const repoIdsWithMatches = new Set<string>()

  for (const f of files) {
    const fileName = f.FileName ?? ""
    const zoektRepoId = f.RepositoryID
    const repoName = f.Repository
    const score = typeof f.Score === "number" ? f.Score : undefined
    const lineMatchCount = Array.isArray(f.LineMatches)
      ? f.LineMatches.length
      : 0

    const repo =
      zoektRepoId != null
        ? byZoektId.get(zoektRepoId)
        : typeof repoName === "string"
          ? byName.get(repoName)
          : undefined

    if (!repo) continue

    repoIdsWithMatches.add(repo.repositoryId)
    const objectId = `file:${repo.repositoryId}:${fileName}`
    candidates.push({
      objectId,
      repositoryId: repo.repositoryId,
      repositoryName: repo.repositoryName,
      path: fileName || undefined,
      query,
      response: first.response,
      score,
      lineMatchCount,
    })
  }

  for (const repoId of repoIdsWithMatches) {
    const r = byRepoId.get(repoId)
    if (!r) continue
    candidates.push({
      objectId: repoId,
      repositoryId: repoId,
      repositoryName: r.repositoryName,
      query: r.query,
      response: r.response,
    })
  }

  if (candidates.length === 0) {
    for (const r of results) {
      candidates.push({
        objectId: r.repositoryId,
        repositoryId: r.repositoryId,
        repositoryName: r.repositoryName,
        query: r.query,
        response: r.response,
      })
    }
  }

  return candidates
}

/**
 * Code search via Zoekt (codesearch service).
 * Searches across all org repositories or a subset by repositoryIds.
 */

export async function codeSearch(
  orgId: string,
  params: {
    query: string
    repositoryIds?: string[]
    workspaceId?: string
  },
): Promise<CodeSearchResult[]> {
  const checkoutKey = params.workspaceId
    ? workspaceCheckoutKey(params.workspaceId)
    : DEFAULT_CHECKOUT_KEY
  const membershipUrls = params.workspaceId
    ? await workspaceCodesearchMembershipUrls(params.workspaceId)
    : null
  if (membershipUrls && membershipUrls.length === 0) return []
  const baseWhere = eq(repositories.orgId, orgId)
  const where = params.repositoryIds?.length
    ? and(baseWhere, inArray(repositories.id, params.repositoryIds))
    : baseWhere

  let repos: { id: string; name: string; gitUrl: string; zoektRepoId: number }[]
  try {
    const db = getOrgDb()
    repos = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        gitUrl: repositories.gitUrl,
        zoektRepoId: repositoryCheckouts.zoektRepoId,
      })
      .from(repositories)
      .innerJoin(
        repositoryCheckouts,
        and(
          eq(repositoryCheckouts.repositoryId, repositories.id),
          eq(repositoryCheckouts.checkoutKey, checkoutKey),
        ),
      )
      .where(where)
  } catch {
    repos = await withOrgDbContext(orgId, async (db) =>
      db
        .select({
          id: repositories.id,
          name: repositories.name,
          gitUrl: repositories.gitUrl,
          zoektRepoId: repositoryCheckouts.zoektRepoId,
        })
        .from(repositories)
        .innerJoin(
          repositoryCheckouts,
          and(
            eq(repositoryCheckouts.repositoryId, repositories.id),
            eq(repositoryCheckouts.checkoutKey, checkoutKey),
          ),
        )
        .where(where),
    )
  }

  if (membershipUrls) {
    const allowed = new Set(membershipUrls)
    repos = repos.filter((repo) =>
      allowed.has(normalizeWorkspaceRepositoryUrl(repo.gitUrl)),
    )
  }

  if (repos.length === 0) return []

  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `org:${orgId}`,
      orgId,
      principal: "service",
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
    },
  })

  const res = await withTransientHttpRetry(
    async () =>
      fetch(`${codesearchBaseUrl()}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          Q: params.query,
          RepoIDs: repos.map((r) => r.zoektRepoId),
        }),
      }),
    { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
  )

  if (!res.ok) {
    throw new Error(`codesearch failed with status ${res.status}`)
  }

  const searchResponse = (await res.json()) as Record<string, unknown>

  return repos.map((r) => ({
    repositoryId: r.id,
    repositoryName: r.name,
    zoektRepoId: r.zoektRepoId,
    query: params.query,
    response: searchResponse,
  }))
}

async function workspaceCodesearchMembershipUrls(
  workspaceId: string,
): Promise<string[]> {
  const workspace = await getWorkspaceById(workspaceId)
  if (!workspace) return []
  const linked = await listLinkedRepositories(workspaceId)
  return codesearchMembershipGitUrls({
    activeProjectionUrl: workspace.activeProjectionUrl,
    linked,
    normalizeUrl: normalizeWorkspaceRepositoryUrl,
  })
}
