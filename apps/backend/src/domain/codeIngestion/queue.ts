import { createError } from "evlog"
import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
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
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ branch: input.branch, githubToken }),
  }).catch((error: Error) => {
    log.set({
      NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
    })
    log.error(error)
    throw createError({
      message: `resolve-ref failed to fetch`,
      why: error.message,
      cause: error,
    })
  })
  if (!res.ok) {
    throw createError({
      message: `resolve-ref failed with status ${res.status}`,
      status: res.status,
      why: await res.text(),
    })
  }
  return (await res.json()) as ResolveRefResponse
}
