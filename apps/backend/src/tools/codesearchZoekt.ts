import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import {
  TransientHttpError,
  withTransientHttpRetry,
} from "../lib/withTransientHttpRetry.js"

export type ZoektRepositoryRow = {
  id: string
  orgId: string
  zoektRepoId: number
  name: string
}

export type ZoektSearchClientFailure = {
  ok: false
  status: number
  error: string
}

export type ZoektSearchResult =
  | Record<string, unknown>
  | ZoektSearchClientFailure

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

export async function zoektSearchRepository(
  repository: ZoektRepositoryRow,
  Q: string,
  opts: Record<string, unknown>,
): Promise<ZoektSearchResult> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `repo:${repository.id}`,
      orgId: repository.orgId,
      principal: "service",
    },
  })

  const res = await withTransientHttpRetry(
    async () => {
      const response = await fetch(`${codesearchBaseUrl()}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          Q,
          RepoIDs: [repository.zoektRepoId],
          Opts: opts,
        }),
        signal: AbortSignal.timeout(ZOEKT_FETCH_TIMEOUT_MS),
      })

      if (
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504
      ) {
        await response.text().catch(() => "")
        throw new TransientHttpError(
          `codesearch transient ${response.status}`,
          response.status,
        )
      }

      return response
    },
    { retries: 2, baseDelayMs: 200 },
  )

  if (res.status >= 400 && res.status < 500) {
    const body = await res.text().catch(() => "")
    return {
      ok: false,
      status: res.status,
      error: body.trim() || `client_error_${res.status}`,
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(
      `codesearch search failed with status ${res.status}: ${body}`,
    )
  }

  return (await res.json()) as Record<string, unknown>
}
