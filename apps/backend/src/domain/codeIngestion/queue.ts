import { createError } from "evlog"
import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
import { getInstallationToken } from "../../models/github-installation.js"
import { getLogger } from "src/observability/logger.js"

type ResolveRefResponse = {
  branch: string
  hash: string
}

export async function resolveRepositoryRef(input: {
  repositoryId: string
  orgId: string
  branch?: string
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
    getInstallationToken(input.orgId, env),
  ])
  const res = await fetch(
    `${codesearchBaseUrl()}/${input.repositoryId}/resolve-ref`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ branch: input.branch, githubToken }),
    },
  )
  if (!res.ok) {
    throw createError({
      message: `resolve-ref failed with status ${res.status}`,
      status: res.status,
      why: await res.text(),
    })
  }
  return (await res.json()) as ResolveRefResponse
}
