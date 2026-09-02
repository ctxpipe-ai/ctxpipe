import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import {
  CodesearchAdmissionBusyError,
  codesearchIndexCloneCheckout,
  codesearchIndexDetectLanguages,
  codesearchIndexMergeScip,
  codesearchIndexScipLang,
  codesearchIndexZoekt,
  isCodesearchAdmissionBusyError,
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
import { parseIndexerConcurrency } from "../codesearchCapacity.js"
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

function zoektStepResult(
  value: unknown,
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
      error:
        typeof error === "string" && error.trim()
          ? error
          : "Search index unavailable",
    }
  }
  return { ok: true }
}

const ADMISSION_SLEEP_DURATION = "30s"
const MAX_INDEX_ADMISSION_RETRIES = 20

type IndexStep = {
  run: (
    opts: { name: string; retryPolicy?: typeof indexRetryPolicy },
    fn: () => Promise<unknown>,
  ) => Promise<unknown>
  sleep: (name: string, duration: string) => Promise<void>
}

type AdmissionOutcome<T> = { admitted: true; value: T } | { admitted: false }

async function runIndexPhaseWithAdmissionRetry<T>(
  step: IndexStep,
  wls: <U>(name: string, fn: () => Promise<U>) => Promise<U>,
  baseName: string,
  fn: () => Promise<T>,
  retryPolicy?: typeof indexRetryPolicy,
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_INDEX_ADMISSION_RETRIES; attempt += 1) {
    const name = attempt === 0 ? baseName : `${baseName}:admit-${attempt}`
    const outcome = (await step.run(
      { name, ...(retryPolicy ? { retryPolicy } : {}) },
      () =>
        wls(name, async (): Promise<AdmissionOutcome<T>> => {
          try {
            return { admitted: true, value: await fn() }
          } catch (error) {
            if (isCodesearchAdmissionBusyError(error)) {
              return { admitted: false }
            }
            throw error
          }
        }),
    )) as AdmissionOutcome<T>
    if (outcome.admitted) return outcome.value
    if (attempt === MAX_INDEX_ADMISSION_RETRIES) {
      throw new CodesearchAdmissionBusyError(
        `${baseName} exceeded index pipeline admission retries`,
      )
    }
    await step.sleep(
      `${baseName}:admit-wait-${attempt}`,
      ADMISSION_SLEEP_DURATION,
    )
  }
  throw new CodesearchAdmissionBusyError(
    `${baseName} exceeded index pipeline admission retries`,
  )
}

async function mapInBatches<T>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(fn))
  }
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
 * detect langs → parallel scip:lang → merge.
 *
 * Zoekt failure is recorded as `searchIndexOk: false` so SCIP and extract can
 * still complete (lexical search degrades; graph/ast-grep remain usable).
 * Clone or SCIP failure still fails the workflow.
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
        const indexStep = step as IndexStep

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

        const checkout = await runIndexPhaseWithAdmissionRetry(
          indexStep,
          wls,
          "clone-checkout",
          () =>
            codesearchIndexCloneCheckout(auth, {
              githubToken: githubToken ?? undefined,
              targetHash: input.targetHash,
              fromHash: input.fromHash,
            }),
          indexRetryPolicy,
        )

        logMilestone("repository-index.clone-checkout.done", {
          repositoryId: input.repositoryId,
          targetHash: checkout.targetHash,
          ingestMode: checkout.ingestMode,
        })

        const zoektResult = zoektStepResult(
          await runIndexPhaseWithAdmissionRetry(
            indexStep,
            wls,
            "zoekt",
            async () => {
              try {
                await codesearchIndexZoekt(auth)
                return { ok: true as const }
              } catch (error) {
                if (isCodesearchAdmissionBusyError(error)) throw error
                const errorText = userFacingIndexingError(error)
                if (isMemoryFitFailure(error)) {
                  logMilestone("repository-index.memory_exceeded", {
                    repositoryId: input.repositoryId,
                    error: errorText,
                  })
                }
                return { ok: false as const, error: errorText }
              }
            },
          ),
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

        const languages = await runIndexPhaseWithAdmissionRetry(
          indexStep,
          wls,
          "detect-languages",
          () =>
            codesearchIndexDetectLanguages(auth, {
              ingestMode: checkout.ingestMode,
              changedPaths: checkout.changedPaths,
              deletedPaths: checkout.deletedPaths,
              renames: checkout.renames,
            }),
          indexRetryPolicy,
        )

        logMilestone("repository-index.detect-languages.done", {
          repositoryId: input.repositoryId,
          detectedCount: languages.detectedLanguages.length,
          toIndexCount: languages.languagesToIndex.length,
        })

        const scipBatchSize = parseIndexerConcurrency(
          process.env.CODESEARCH_INDEXER_CONCURRENCY,
        )
        await mapInBatches(languages.languagesToIndex, scipBatchSize, (lang) =>
          runIndexPhaseWithAdmissionRetry(
            indexStep,
            wls,
            `scip:${lang}`,
            () =>
              codesearchIndexScipLang(auth, lang, languages.detectedLanguages),
            indexRetryPolicy,
          ),
        )

        await runIndexPhaseWithAdmissionRetry(
          indexStep,
          wls,
          "merge-scip",
          () => codesearchIndexMergeScip(auth, languages.detectedLanguages),
          indexRetryPolicy,
        )

        logMilestone("repository-index.merge-scip.done", {
          repositoryId: input.repositoryId,
        })

        return {
          indexedAt: new Date().toISOString(),
          targetHash: checkout.targetHash,
          ingestMode: checkout.ingestMode,
          changedPaths: checkout.changedPaths,
          deletedPaths: checkout.deletedPaths,
          renames: checkout.renames,
          searchIndexOk,
          searchIndexError,
        }
      },
    ),
)
