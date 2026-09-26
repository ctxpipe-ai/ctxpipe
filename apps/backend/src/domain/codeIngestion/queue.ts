import { createError } from "evlog"
import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
import { withTransientHttpRetry } from "../../lib/withTransientHttpRetry.js"
import { getInstallationToken } from "../../models/github-installation.js"
import { getLogger } from "../../observability/logger.js"

type ResolveRefResponse = {
  branch: string
  hash: string
}

export async function resolveRepositoryRef(input: {
  repositoryId: string
  orgId: string
  branch?: string
  githubConnectionId?: string | null
}): Promise<ResolveRefResponse> {
  const log = getLogger()
  log.set({
    repositoryId: input.repositoryId,
    orgId: input.orgId,
    branch: input.branch,
  })
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const [token, githubToken] = await Promise.all([
    signUpstreamJwt({
      env,
      audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
      claims: {
        sub: `repo:${input.repositoryId}`,
        orgId: input.orgId,
        principal: "service",
      },
    }),
    getInstallationToken(
      input.orgId,
      env,
      input.githubConnectionId ?? undefined,
    ),
  ])
  const url = `${codesearchBaseUrl()}/${input.repositoryId}/resolve-ref`
  let res: Response
  try {
    res = await withTransientHttpRetry(
      async () =>
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ branch: input.branch, githubToken }),
        }),
      { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
    )
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error))
    log.set({
      NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
    })
    log.error(err)
    throw createError({
      message: `resolve-ref failed to fetch`,
      why: err.message,
      cause: err,
    })
  }
  if (!res.ok) {
    throw createError({
      message: `resolve-ref failed with status ${res.status}`,
      status: res.status,
      why: await res.text(),
    })
  }
  return (await res.json()) as ResolveRefResponse
}
