import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import {
  codesearchIndexCloneCheckout,
  codesearchIndexDetectLanguages,
  codesearchIndexMergeScip,
  codesearchIndexScipLang,
  codesearchIndexZoekt,
} from "../../domain/codeIngestion/codesearchIndexPhases.js"
import {
  isMemoryFitFailure,
  userFacingIndexingError,
} from "../../lib/memoryFitError.js"
import { getInstallationToken } from "../../models/github-installation.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { withLoggedStepAttempt } from "../withLoggedStepAttempt.js"

const repositoryIndexInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  targetHash: z.string().min(1),
  fromHash: z.string().optional(),
  githubConnectionId: z.string().optional(),
})

const indexRetryPolicy = {
  maximumAttempts: 2,
  initialInterval: "30s" as const,
  backoffCoefficient: 2,
  maximumInterval: "2m" as const,
}

function optionalIndexStepResult(
  value: unknown,
  fallbackError: string,
): { ok: true } | { ok: false; error: string } {
  if (
    value &&
    typeof value === "object" &&
    "ok" in value &&
    (value as { ok: unknown }).ok === false
  ) {
    const error = (value as { error?: unknown }).error
    return {
      ok: false,
      error: typeof error === "string" && error.trim() ? error : fallbackError,
    }
  }
  return { ok: true }
}

function mergeScipStepResult(
  value: unknown,
): { ok: true; shardCount?: number } | { ok: false; error: string } {
  const result = optionalIndexStepResult(value, "SCIP index unavailable")
  if (!result.ok) {
    return result
  }
  const shardCount =
    value &&
    typeof value === "object" &&
    "shardCount" in value &&
    typeof (value as { shardCount: unknown }).shardCount === "number"
      ? (value as { shardCount: number }).shardCount
      : undefined
  return { ok: true, shardCount }
}

function joinIndexErrors(errors: string[]): string | undefined {
  const unique = [
    ...new Set(errors.map((error) => error.trim()).filter(Boolean)),
  ]
  return unique.length > 0 ? unique.join("; ") : undefined
}

function logMilestone(step: string, fields: Record<string, unknown>): void {
  const l = getLogger()
  l.set({
    step,
    component: "openworkflow-worker",
    at: new Date().toISOString(),
    pid: process.pid,
    ...fields,
  })
  l.info(step)
  flushWorkflowLog()
}

/**
 * Durable codesearch index pipeline: clone/checkout → zoekt (non-fatal) →
 * detect langs → parallel scip:lang (non-fatal) → merge (non-fatal).
 *
 * Zoekt or SCIP failure is recorded on the result so extract can still
 * complete (lexical search and/or graph tools degrade). Clone failure
 * still fails the workflow.
 */
export const repositoryIndex = defineWorkflow(
  { name: "repository-index", schema: repositoryIndexInputSchema },
  async ({ input, step }) =>
    withLogger(
      createLogger({
        workflow: "repository-index",
        repositoryId: input.repositoryId,
        orgId: input.orgId,
      }),
      async () => {
        const auth = {
          repositoryId: input.repositoryId,
          orgId: input.orgId,
        }
        const wls = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
          withLoggedStepAttempt(
            name,
            {
              workflow: "repository-index",
              repositoryId: input.repositoryId,
              orgId: input.orgId,
            },
            fn,
          )

        logMilestone("repository-index.start", {
          repositoryId: input.repositoryId,
          targetHash: input.targetHash,
        })

        const env = parseEnv(process.env as Record<string, string | undefined>)
        const githubToken = await step.run(
          { name: "resolve-github-token" },
          () =>
            wls("resolve-github-token", () =>
              getInstallationToken(input.orgId, env, input.githubConnectionId),
            ),
        )

        const checkout = await step.run(
          { name: "clone-checkout", retryPolicy: indexRetryPolicy },
          () =>
            wls("clone-checkout", () =>
              codesearchIndexCloneCheckout(auth, {
                githubToken: githubToken ?? undefined,
                targetHash: input.targetHash,
                fromHash: input.fromHash,
              }),
            ),
        )

        logMilestone("repository-index.clone-checkout.done", {
          repositoryId: input.repositoryId,
          targetHash: checkout.targetHash,
          ingestMode: checkout.ingestMode,
        })

        const zoektResult = optionalIndexStepResult(
          await step.run({ name: "zoekt" }, () =>
            wls("zoekt", async () => {
              try {
                await codesearchIndexZoekt(auth)
                return { ok: true as const }
              } catch (error) {
                const errorText = userFacingIndexingError(error)
                if (isMemoryFitFailure(error)) {
                  logMilestone("repository-index.memory_exceeded", {
                    repositoryId: input.repositoryId,
                    error: errorText,
                  })
                }
                return { ok: false as const, error: errorText }
              }
            }),
          ),
          "Search index unavailable",
        )
        const searchIndexOk = zoektResult.ok
        const searchIndexError = zoektResult.ok ? undefined : zoektResult.error
        if (searchIndexOk) {
          logMilestone("repository-index.zoekt.done", {
            repositoryId: input.repositoryId,
          })
        } else {
          logMilestone("repository-index.zoekt.failed", {
            repositoryId: input.repositoryId,
            error: searchIndexError,
          })
        }

        const languages = await step.run(
          { name: "detect-languages", retryPolicy: indexRetryPolicy },
          () =>
            wls("detect-languages", () =>
              codesearchIndexDetectLanguages(auth, {
                ingestMode: checkout.ingestMode,
                changedPaths: checkout.changedPaths,
                deletedPaths: checkout.deletedPaths,
                renames: checkout.renames,
              }),
            ),
        )

        logMilestone("repository-index.detect-languages.done", {
          repositoryId: input.repositoryId,
          detectedCount: languages.detectedLanguages.length,
          toIndexCount: languages.languagesToIndex.length,
        })

        const skipScipAfterZoektMemory =
          !searchIndexOk && isMemoryFitFailure(searchIndexError ?? "")

        let scipIndexOk = true
        let scipIndexError: string | undefined
        const languagesToIndex = skipScipAfterZoektMemory
          ? []
          : languages.languagesToIndex

        if (skipScipAfterZoektMemory) {
          scipIndexOk = false
          scipIndexError = searchIndexError ?? "SCIP index unavailable"
          logMilestone("repository-index.scip.skipped", {
            repositoryId: input.repositoryId,
            reason: "zoekt_memory_fit",
            error: scipIndexError,
          })
        }

        const scipResults = await Promise.all(
          languagesToIndex.map((lang) =>
            step.run({ name: `scip:${lang}` }, () =>
              wls(`scip:${lang}`, async () => {
                try {
                  await codesearchIndexScipLang(
                    auth,
                    lang,
                    languages.detectedLanguages,
                  )
                  return { ok: true as const }
                } catch (error) {
                  const errorText = userFacingIndexingError(error)
                  if (isMemoryFitFailure(error)) {
                    logMilestone("repository-index.memory_exceeded", {
                      repositoryId: input.repositoryId,
                      phase: `scip:${lang}`,
                      error: errorText,
                    })
                  }
                  return { ok: false as const, error: errorText }
                }
              }),
            ),
          ),
        )

        const failedScip = scipResults
          .map((value) =>
            optionalIndexStepResult(value, "SCIP index unavailable"),
          )
          .filter((result) => !result.ok)
        if (failedScip.length > 0) {
          scipIndexOk = false
          scipIndexError = joinIndexErrors(
            failedScip.map((result) => result.error),
          )
          logMilestone("repository-index.scip.failed", {
            repositoryId: input.repositoryId,
            error: scipIndexError,
            failedCount: failedScip.length,
          })
        }

        const mergeResult = mergeScipStepResult(
          await step.run({ name: "merge-scip" }, () =>
            wls("merge-scip", async () => {
              try {
                const merged = await codesearchIndexMergeScip(
                  auth,
                  languages.detectedLanguages,
                  skipScipAfterZoektMemory ? [] : undefined,
                )
                return { ok: true as const, shardCount: merged.shardCount }
              } catch (error) {
                const errorText = userFacingIndexingError(error)
                if (isMemoryFitFailure(error)) {
                  logMilestone("repository-index.memory_exceeded", {
                    repositoryId: input.repositoryId,
                    phase: "merge-scip",
                    error: errorText,
                  })
                }
                return { ok: false as const, error: errorText }
              }
            }),
          ),
        )
        if (mergeResult.ok) {
          logMilestone("repository-index.merge-scip.done", {
            repositoryId: input.repositoryId,
            shardCount: mergeResult.shardCount,
          })
          if (
            languages.detectedLanguages.length > 0 &&
            mergeResult.shardCount === 0
          ) {
            scipIndexOk = false
            scipIndexError = joinIndexErrors([
              ...(scipIndexError ? [scipIndexError] : []),
              "SCIP index unavailable",
            ])
            logMilestone("repository-index.scip.failed", {
              repositoryId: input.repositoryId,
              error: scipIndexError,
              reason: "zero_valid_shards",
            })
          }
        } else {
          scipIndexOk = false
          scipIndexError = joinIndexErrors([
            ...(scipIndexError ? [scipIndexError] : []),
            mergeResult.error,
          ])
          logMilestone("repository-index.merge-scip.failed", {
            repositoryId: input.repositoryId,
            error: mergeResult.error,
          })
        }

        return {
          indexedAt: new Date().toISOString(),
          targetHash: checkout.targetHash,
          ingestMode: checkout.ingestMode,
          changedPaths: checkout.changedPaths,
          deletedPaths: checkout.deletedPaths,
          renames: checkout.renames,
          searchIndexOk,
          searchIndexError,
          scipIndexOk,
          scipIndexError,
        }
      },
    ),
)
