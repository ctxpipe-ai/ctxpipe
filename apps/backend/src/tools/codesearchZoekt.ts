import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import { withTransientHttpRetry } from "../lib/withTransientHttpRetry.js"

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

/** Prefer codesearch's `{ error }` JSON so agents see the query message. */
export function codesearchClientErrorDetail(
  body: string,
  status: number,
): string {
  const trimmed = body.trim()
  if (!trimmed) return `client_error_${status}`
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown }
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error.trim()
    }
  } catch {
    // plain text
  }
  return trimmed
}

/** 4xx from codesearch `/search`. Null for 2xx and for 5xx/network, which stay throws. */
export async function readCodesearchClientFailure(
  res: Response,
): Promise<ZoektSearchClientFailure | null> {
  if (res.status < 400 || res.status >= 500) return null
  const body = await res.text().catch(() => "")
  return {
    ok: false,
    status: res.status,
    error: codesearchClientErrorDetail(body, res.status),
  }
}

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
    async () =>
      fetch(`${codesearchBaseUrl()}/search`, {
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
      }),
    { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
  )

  const failure = await readCodesearchClientFailure(res)
  if (failure) return failure

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(
      `codesearch search failed with status ${res.status}: ${body}`,
    )
  }

  return (await res.json()) as Record<string, unknown>
}
