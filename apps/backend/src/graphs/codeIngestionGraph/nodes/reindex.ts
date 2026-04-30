import { z } from "zod/v3"
import { signUpstreamJwt } from "../../../auth/upstreamJwt.js"
import { parseEnv } from "../../../config/env.js"
import { codesearchBaseUrl } from "../../../lib/agentToolRuntime.js"
import { getInstallationToken } from "../../../models/github-installation.js"
import type { CodeIngestionState } from "../schemas.js"
import { flushWorkflowLog, getLogger } from "../../../observability/logger.js"

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
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const logger = getLogger()
  logger.set({
    step: "codeIngestion.reindex.start",
    component: "openworkflow-worker",
    repositoryId: state.repositoryId,
    orgId: state.orgId,
    targetHash: state.targetHash,
    fromHash: state.fromHash,
    sourceBranch: state.sourceBranch,
    at: new Date().toISOString(),
    pid: process.pid,
  })
  logger.info("codeIngestion reindex start")
  logger.set({ state })
  logger.info("reindexing repository")
  flushWorkflowLog()
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
    getInstallationToken(
      state.orgId,
      env,
      state.githubConnectionId ?? undefined,
    ),
  ])
  const res = await fetch(
    `${codesearchBaseUrl()}/${state.repositoryId}/index`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        githubToken,
        targetHash: state.targetHash,
        fromHash: state.fromHash,
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
  if (data.targetHash !== state.targetHash) {
    logger.warn("codesearch targetHash differs from graph state targetHash", {
      stateTargetHash: state.targetHash,
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
