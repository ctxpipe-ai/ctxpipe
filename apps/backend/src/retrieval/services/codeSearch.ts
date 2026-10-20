import { and, eq, inArray } from "drizzle-orm"
import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { assertNotInOrgDbContext, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import { publishedProjection } from "../../domain/workspaces/revision.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
import {
  type CodesearchHttpOptions,
  readCodesearchError,
} from "../../lib/codesearchError.js"
import { withTransientHttpRetry } from "../../lib/withTransientHttpRetry.js"
import { publishedRepositoryCheckoutKey } from "../../models/repositories.js"
import { getWorkspaceSearchProjection } from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"

/**
 * Zoekt treats unquoted text as a query (regex, filters, grouping). A user
 * question is a substring: quote it and escape `\` and `"`.
 */
export function zoektLiteralQuery(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** Zoekt rejected the query. Only `strict` calls get it; others retry as a literal. */
export class CodeSearchRejectedError extends Error {
  override readonly name = "CodeSearchRejectedError"
}

type CodeSearchResult = {
  repositoryId: string
  repositoryName: string
  zoektRepoId: number
  query: string
  response: Record<string, unknown>
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
    workspaceSnapshot?: Awaited<ReturnType<typeof getWorkspaceSearchProjection>>
    /** Repositories that the caller already resolved; skips the checkout query. */
    repositories?: Array<{ id: string; name: string; zoektRepoId: number }>
    /** Throw {@link CodeSearchRejectedError} on a rejected query, with no literal retry. */
    strict?: boolean
    transport?: CodesearchHttpOptions
  },
): Promise<CodeSearchResult[]> {
  const workspace = params.workspaceId
    ? (params.workspaceSnapshot ??
      (await withOrgDbContext(orgId, () =>
        getWorkspaceSearchProjection(params.workspaceId as string),
      )))
    : null
  const baseWhere = eq(repositories.orgId, orgId)
  const where = params.repositoryIds?.length
    ? and(baseWhere, inArray(repositories.id, params.repositoryIds))
    : baseWhere

  const repos = params.repositories
    ? params.repositories
    : workspace
      ? workspace.repositories.filter(
          (repo) =>
            !params.repositoryIds?.length ||
            params.repositoryIds.includes(repo.id),
        )
      : await withOrgDbContext(orgId, async (db) =>
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
                eq(
                  repositoryCheckouts.checkoutKey,
                  publishedRepositoryCheckoutKey(),
                ),
              ),
            )
            .where(where),
        )

  if (repos.length === 0) return []

  assertNotInOrgDbContext()
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `org:${orgId}`,
      orgId,
      principal: "service",
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(workspace &&
      publishedProjection(workspace.projection)?.kind === "legacy"
        ? { legacyWorkspace: true as const }
        : {}),
      ...(workspace &&
      publishedProjection(workspace.projection)?.kind === "active"
        ? {
            workspaceRevisions: workspace.repositories
              .filter((repo) =>
                repos.some(
                  (selected) => selected.zoektRepoId === repo.zoektRepoId,
                ),
              )
              .map((repo) => ({ repositoryId: repo.id, sha: repo.sha })),
          }
        : {}),
    },
  })
  const repoIds = repos.map((r) => r.zoektRepoId)

  const postSearch = (query: string) =>
    withTransientHttpRetry(
      async () =>
        fetch(`${codesearchBaseUrl()}/search`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            Q: query,
            RepoIDs: repoIds,
          }),
          signal: params.transport?.signal,
        }),
      params.transport?.retry ?? {
        retries: 10,
        baseDelayMs: 200,
        maxDelayMs: 30_000,
      },
    )

  const readRejection = async (response: Response) => {
    if (response.status !== 400) return null
    const failure = await readCodesearchError(response)
    return failure.code === "query_rejected" ? failure : null
  }

  let query = params.query
  let res = await postSearch(query)
  let rejected = await readRejection(res)
  if (rejected && params.strict) {
    throw new CodeSearchRejectedError(rejected.message)
  }
  if (rejected) {
    const literal = zoektLiteralQuery(params.query)
    if (literal !== params.query) {
      query = literal
      res = await postSearch(literal)
      rejected = await readRejection(res)
    }
    if (rejected) {
      // Codesearch's error string can echo the query. Keep it off the wide event.
      log.warn({
        step: "advisor.code_search.rejected",
        "upstream.status_code": rejected.status,
        error: "zoekt_query_rejected",
      })
      return []
    }
  }

  if (!res.ok) {
    throw new Error(`codesearch failed with status ${res.status}`)
  }

  const rawResponse = (await res.json()) as Record<string, unknown>
  const result =
    rawResponse.Result && typeof rawResponse.Result === "object"
      ? (rawResponse.Result as Record<string, unknown>)
      : rawResponse
  let searchResponse = result
  let matchingRepos = repos
  if (workspace) {
    const expected = new Map(
      workspace.repositories
        .filter((repo) => repos.some((selected) => selected.id === repo.id))
        .map((repo) => [repo.zoektRepoId, repo.sha]),
    )
    const files = (Array.isArray(result.Files) ? result.Files : []).filter(
      (file) =>
        file &&
        typeof file === "object" &&
        typeof file.Version === "string" &&
        expected.get(file.RepositoryID) === file.Version,
    )
    if (files.length === 0) return []
    const matchingIds = new Set(files.map((file) => file.RepositoryID))
    matchingRepos = repos.filter((repo) => matchingIds.has(repo.zoektRepoId))
    searchResponse = { Files: files }
  }
  return matchingRepos.map((r) => ({
    repositoryId: r.id,
    repositoryName: r.name,
    zoektRepoId: r.zoektRepoId,
    query,
    response: searchResponse,
  }))
}
