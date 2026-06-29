import { z } from "zod/v3"
import { signUpstreamJwt } from "../../../auth/upstreamJwt.js"
import { parseEnv } from "../../../config/env.js"
import { codesearchBaseUrl } from "../../../lib/agentToolRuntime.js"
import { getInstallationToken } from "../../../models/github-installation.js"
import { flushWorkflowLog, getLogger } from "../../../observability/logger.js"

export type CodeIngestionReindexInput = {
  repositoryId: string
  orgId: string
  targetHash: string
  fromHash?: string
  githubConnectionId?: string
  sourceBranch?: string
}

export type CodeIngestionReindexOutput = {
  indexedAt: string
  targetHash: string
  ingestMode: "full" | "partial"
  changedPaths: string[]
  deletedPaths: string[]
  renames: Array<{ from: string; to: string }>
}

const codesearchIndexResponseSchema = z.object({
  ok: z.literal(true),
  targetHash: z.string(),
  ingestMode: z.enum(["full", "partial"]),
  changedPaths: z.array(z.string()),
  deletedPaths: z.array(z.string()),
  renames: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
    }),
  ),
  message: z.string().optional(),
})

export async function reindex(
  input: CodeIngestionReindexInput,
): Promise<CodeIngestionReindexOutput> {
  let logger = getLogger()
  logger.set({
    step: "codeIngestion.reindex.start",
    component: "openworkflow-worker",
    repositoryId: input.repositoryId,
    orgId: input.orgId,
    targetHash: input.targetHash,
    fromHash: input.fromHash,
    sourceBranch: input.sourceBranch,
    at: new Date().toISOString(),
    pid: process.pid,
  })
  logger.info("codeIngestion reindex start")
  logger.set({ input })
  logger.info("reindexing repository")
  flushWorkflowLog()
  logger = getLogger()
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
  const res = await fetch(
    `${codesearchBaseUrl()}/${input.repositoryId}/index`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        githubToken,
        targetHash: input.targetHash,
        fromHash: input.fromHash,
      }),
    },
  )
  if (!res.ok) {
    const bodyText = await res.text()
    let detail = bodyText.trim()
    try {
      const parsed = JSON.parse(bodyText) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        detail = parsed.error
      }
    } catch {
      // non-JSON body; use raw text
    }
    logger.error("codesearch reindex failed", {
      status: res.status,
      detail,
      body: bodyText,
    })
    flushWorkflowLog()
    throw new Error(
      `codesearch reindex failed with status ${res.status}: ${detail}`,
    )
  }
  const json: unknown = await res.json()
  const parsed = codesearchIndexResponseSchema.safeParse(json)
  if (!parsed.success) {
    logger.error("codesearch reindex: response JSON did not match schema", {
      issues: parsed.error.flatten(),
      json,
    })
    throw new Error("codesearch reindex returned unexpected JSON body")
  }
  const data = parsed.data
  if (data.targetHash !== input.targetHash) {
    logger.warn("codesearch targetHash differs from graph state targetHash", {
      stateTargetHash: input.targetHash,
      codesearchTargetHash: data.targetHash,
    })
  }
  return {
    indexedAt: new Date().toISOString(),
    targetHash: data.targetHash,
    ingestMode: data.ingestMode,
    changedPaths: data.changedPaths,
    deletedPaths: data.deletedPaths,
    renames: data.renames,
  }
}
