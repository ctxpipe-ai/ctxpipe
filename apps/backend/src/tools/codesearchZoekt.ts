import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"

export type ZoektRepositoryRow = {
  id: string
  orgId: string
  zoektRepoId: number
  name: string
}

export async function zoektSearchRepository(
  repository: ZoektRepositoryRow,
  Q: string,
  opts: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
  const res = await fetch(`${codesearchBaseUrl()}/search`, {
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
  })
  if (!res.ok) {
    throw new Error(`codesearch search failed with status ${res.status}`)
  }
  return (await res.json()) as Record<string, unknown>
}
