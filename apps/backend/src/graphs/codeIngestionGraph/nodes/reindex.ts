import { signUpstreamJwt } from "../../../auth/upstreamJwt.js"
import { parseEnv } from "../../../config/env.js"
import { codesearchBaseUrl } from "../../../lib/agentToolRuntime.js"
import { getInstallationToken } from "../../../models/github-installation.js"

export async function reindex(state: {
  repositoryId: string
  orgId: string
  fromHash?: string
  sourceBranch?: string
  targetHash: string
}) {
  console.log("reindexing repository", state)
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const [token, githubToken] = await Promise.all([
    signUpstreamJwt({
      env,
      audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
      claims: {
        sub: `repo:${state.repositoryId}`,
        orgId: state.orgId,
        principal: "service",
      },
    }),
    getInstallationToken(state.orgId, env),
  ])
  const res = await fetch(
    `${codesearchBaseUrl()}/${state.repositoryId}/index`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ githubToken }),
    },
  )
  if (!res.ok) {
    throw new Error(`codesearch reindex failed with status ${res.status}`)
  }
  return {
    indexedAt: new Date().toISOString(),
  }
}
