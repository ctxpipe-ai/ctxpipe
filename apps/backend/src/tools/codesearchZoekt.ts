import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import { capturedSourceRevision } from "../domain/codeIngestion/source-revision-context.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import { readCodesearchError } from "../lib/codesearchError.js"
import { withTransientHttpRetry } from "../lib/withTransientHttpRetry.js"

export type ZoektRepositoryRow = {
  id: string
  orgId: string
  zoektRepoId: number
  name: string
}

type ZoektSearchClientFailure = {
  ok: false
  status: number
  error: string
}

type ZoektSearchResult = Record<string, unknown> | ZoektSearchClientFailure

export function isZoektSearchClientFailure(
  r: ZoektSearchResult,
): r is ZoektSearchClientFailure {
  return (
    typeof r === "object" &&
    r !== null &&
    "ok" in r &&
    (r as ZoektSearchClientFailure).ok === false
  )
}

const ZOEKT_FETCH_TIMEOUT_MS = 10_000

/**
 * Zoekt search in one repository. A captured source revision or a
 * `workspace` revision scopes the search to that checkout by claim; without
 * one, `zoektRepoId` selects the published checkout.
 */
export async function zoektSearchRepository(
  repository: Pick<ZoektRepositoryRow, "id" | "orgId"> & {
    zoektRepoId?: number
  },
  Q: string,
  opts: Record<string, unknown>,
  workspace?: { workspaceId: string },
): Promise<ZoektSearchResult> {
  const source = capturedSourceRevision(repository.orgId, repository.id)
  if (source && workspace)
    throw new Error("Extraction tool cannot select a workspace projection")
  if (!source && !workspace && repository.zoektRepoId === undefined)
    throw new Error("Zoekt search needs a checkout")
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `repo:${repository.id}`,
      orgId: repository.orgId,
      principal: "service",
      ...(source
        ? {
            repositoryRevisions: [
              { repositoryId: source.repositoryId, sha: source.sha },
            ],
          }
        : {}),
      ...(workspace
        ? {
            workspaceId: workspace.workspaceId,
            workspaceRepositoryIds: [repository.id],
          }
        : {}),
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
          Q,
          ...(source || workspace ? {} : { RepoIDs: [repository.zoektRepoId] }),
          Opts: opts,
        }),
        signal: AbortSignal.timeout(ZOEKT_FETCH_TIMEOUT_MS),
      }),
    { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
  )

  if (res.status >= 400 && res.status < 500) {
    const failure = await readCodesearchError(res)
    return {
      ok: false,
      status: failure.status,
      error: failure.message || `client_error_${failure.status}`,
    }
  }

  if (!res.ok) {
    const failure = await readCodesearchError(res)
    throw new Error(
      `codesearch search failed with status ${failure.status}: ${failure.message}`,
    )
  }

  return (await res.json()) as Record<string, unknown>
}
