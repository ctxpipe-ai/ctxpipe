import { and, eq, inArray } from "drizzle-orm"
import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"

export type CodeSearchResult = {
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
  },
): Promise<CodeSearchResult[]> {
  const repos = await withOrgDbContext(orgId, async (db) => {
    const baseWhere = eq(repositories.orgId, orgId)
    const where = params.repositoryIds?.length
      ? and(baseWhere, inArray(repositories.id, params.repositoryIds))
      : baseWhere
    return db
      .select({
        id: repositories.id,
        name: repositories.name,
        zoektRepoId: repositories.zoektRepoId,
      })
      .from(repositories)
      .where(where)
  })

  if (repos.length === 0) return []

  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `org:${orgId}`,
      orgId,
      principal: "service",
    },
  })

  const res = await fetch(`${codesearchBaseUrl()}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      Q: params.query,
      RepoIDs: repos.map((r) => r.zoektRepoId),
    }),
  })

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
