import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { repositoryIngestionQueue } from "../../db/schema/repositoryIngestionQueue.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
import { generateObjectId } from "../../lib/id.js"
import { getDb } from "../../db/client.js"

type ResolveRefResponse = {
  branch: string
  hash: string
}

export async function resolveRepositoryRef(input: {
  repositoryId: string
  orgId: string
  branch?: string
}): Promise<ResolveRefResponse> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `repo:${input.repositoryId}`,
      orgId: input.orgId,
      principal: "service",
    },
  })
  const res = await fetch(`${codesearchBaseUrl()}/${input.repositoryId}/resolve-ref`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ branch: input.branch }),
  })
  if (!res.ok) {
    throw new Error(`resolve-ref failed with status ${res.status}`)
  }
  return (await res.json()) as ResolveRefResponse
}

export async function enqueueRepositoryIngestion(input: {
  repositoryId: string
  orgId: string
  targetHash: string
  sourceBranch?: string
  fromHash?: string | null
}) {
  const id = generateObjectId("ingq")
  const [job] = await getDb()
    .insert(repositoryIngestionQueue)
    .values({
      id,
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      targetHash: input.targetHash,
      sourceBranch: input.sourceBranch,
      fromHash: input.fromHash ?? null,
      status: "pending",
    })
    .returning()
  if (job) return job
  throw new Error("Failed to enqueue repository ingestion")
}
