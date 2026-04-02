import { signUpstreamJwt } from "../../../auth/upstreamJwt.js"
import { parseEnv } from "../../../config/env.js"
import { codesearchBaseUrl } from "../../../lib/agentToolRuntime.js"
import { getInstallationToken } from "../../../models/github-installation.js"
import { flushWorkflowLog, getLogger } from "../../../observability/logger.js"

export async function reindex(state: {
  repositoryId: string
  orgId: string
  fromHash?: string
  sourceBranch?: string
  targetHash: string
}) {
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
  const indexedAt = new Date().toISOString()
  logger.set({
    step: "codeIngestion.reindex.summary",
    repositoryId: state.repositoryId,
    orgId: state.orgId,
    targetHash: state.targetHash,
    indexedAt,
    codesearchStatus: res.status,
  })
  logger.info("codesearch reindex ok")
  flushWorkflowLog()
  return {
    indexedAt,
  }
}
