import { signUpstreamJwt } from "../../../auth/upstreamJwt.js"
import { parseEnv } from "../../../config/env.js"
import { codesearchBaseUrl } from "../../../lib/agentToolRuntime.js"

export async function reindex(state: {
  repositoryId: string
  orgId: string
  fromHash?: string
  sourceBranch?: string
  targetHash: string
}) {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `repo:${state.repositoryId}`,
      orgId: state.orgId,
      principal: "service",
    },
  })
  const res = await fetch(
    `${codesearchBaseUrl()}/${state.repositoryId}/index`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  if (!res.ok) {
    throw new Error(`codesearch reindex failed with status ${res.status}`)
  }
  return {
    indexedAt: new Date().toISOString(),
  }
}
