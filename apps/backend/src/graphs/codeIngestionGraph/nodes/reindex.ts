import { trace } from "@opentelemetry/api"
import { z } from "zod/v3"
import { signUpstreamJwt } from "../../../auth/upstreamJwt.js"
import { parseEnv } from "../../../config/env.js"
import { codesearchBaseUrl } from "../../../lib/agentToolRuntime.js"
import { withTransientHttpRetry } from "../../../lib/withTransientHttpRetry.js"
import { getInstallationToken } from "../../../models/github-installation.js"
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

type ReindexInput = {
  repositoryId: string
  orgId: string
  targetHash: string
  fromHash?: string
  sourceBranch?: string
  githubConnectionId?: string
}

export type ReindexStepResult = {
  indexedAt: string
  targetHash: string
  ingestMode: "full" | "partial"
  changedPaths: string[]
  deletedPaths: string[]
  renames: Array<{ from: string; to: string }>
}

export async function reindex(state: ReindexInput): Promise<ReindexStepResult> {
  let logger = getLogger()
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
  logger = getLogger()
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const githubToken = await getInstallationToken(
    state.orgId,
    env,
    state.githubConnectionId ?? undefined,
  )

  logger.set({
    step: "codeIngestion.reindex.http.start",
    repositoryId: state.repositoryId,
    orgId: state.orgId,
    targetHash: state.targetHash,
  })
  logger.info("reindex HTTP start")
  flushWorkflowLog()

  const httpStartTime = Date.now()
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined

  const result = await trace
    .getTracer("ctxpipe-backend")
    .startActiveSpan(
      "repository-ingestion.reindex",
      {
        attributes: {
          repositoryId: state.repositoryId,
          orgId: state.orgId,
          targetHash: state.targetHash,
        },
      },
      async (span): Promise<ReindexStepResult> => {
        let loggedHttpFail = false
        try {
          heartbeatInterval = setInterval(() => {
            const elapsedMs = Date.now() - httpStartTime
            const waitLogger = getLogger()
            waitLogger.set({
              step: "codeIngestion.reindex.http.waiting",
              elapsedMs,
              repositoryId: state.repositoryId,
              targetHash: state.targetHash,
            })
            waitLogger.info("reindex HTTP waiting")
            flushWorkflowLog()
          }, 30_000)

          const res = await withTransientHttpRetry(
            async () => {
              const token = await signUpstreamJwt({
                env,
                audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
                claims: {
                  sub: `repo:${state.repositoryId}`,
                  orgId: state.orgId,
                  principal: "service",
                },
              })
              return fetch(`${codesearchBaseUrl()}/${state.repositoryId}/index`, {
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
              })
            },
            { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
          )

          const durationMs = Date.now() - httpStartTime

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
            const failLogger = getLogger()
            failLogger.set({
              step: "codeIngestion.reindex.http.fail",
              durationMs,
              status: res.status,
              error: detail,
            })
            failLogger.error("codesearch reindex failed", {
              status: res.status,
              detail,
              body: bodyText,
            })
            loggedHttpFail = true
            flushWorkflowLog()
            throw new Error(
              `codesearch reindex failed with status ${res.status}: ${detail}`,
            )
          }

          const json: unknown = await res.json()
          const parsed = codesearchIndexResponseSchema.safeParse(json)
          if (!parsed.success) {
            const failLogger = getLogger()
            failLogger.set({
              step: "codeIngestion.reindex.http.fail",
              durationMs,
              status: res.status,
              error: "response JSON did not match schema",
            })
            failLogger.error(
              "codesearch reindex: response JSON did not match schema",
              {
                issues: parsed.error.flatten(),
                json,
              },
            )
            loggedHttpFail = true
            flushWorkflowLog()
            throw new Error("codesearch reindex returned unexpected JSON body")
          }

          const data = parsed.data
          if (data.targetHash !== state.targetHash) {
            getLogger().warn(
              "codesearch targetHash differs from graph state targetHash",
              {
                stateTargetHash: state.targetHash,
                codesearchTargetHash: data.targetHash,
              },
            )
          }

          const doneLogger = getLogger()
          doneLogger.set({
            step: "codeIngestion.reindex.http.done",
            durationMs,
            status: res.status,
            ingestMode: data.ingestMode,
            changedPathCount: data.changedPaths.length,
            deletedPathCount: data.deletedPaths.length,
            renameCount: data.renames.length,
          })
          doneLogger.info("reindex HTTP done")
          flushWorkflowLog()

          return {
            indexedAt: new Date().toISOString(),
            targetHash: data.targetHash,
            ingestMode: data.ingestMode,
            changedPaths: data.changedPaths,
            deletedPaths: data.deletedPaths,
            renames: data.renames,
          }
        } catch (error) {
          if (!loggedHttpFail) {
            const durationMs = Date.now() - httpStartTime
            const errorMessage =
              error instanceof Error ? error.message : String(error)
            const errorName =
              error instanceof Error ? error.name : typeof error
            const failLogger = getLogger()
            failLogger.set({
              step: "codeIngestion.reindex.http.fail",
              durationMs,
              error: errorMessage,
              errorName,
            })
            failLogger.error("codesearch reindex HTTP failed", {
              error: errorMessage,
              errorName,
              stack: error instanceof Error ? error.stack : undefined,
            })
            flushWorkflowLog()
          }
          throw error
        } finally {
          clearInterval(heartbeatInterval)
          span.end()
        }
      },
    )

  return result
}
