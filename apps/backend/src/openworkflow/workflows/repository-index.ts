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
import { getInstallationToken } from "../../models/github-installation.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { publishWorkspaceIndexAfterCodesearch } from "../publish-workspace-index.js"
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
 * Durable codesearch index pipeline: clone/checkout → zoekt (fail-fast) →
 * detect langs → parallel scip:lang → merge.
 *
 * Intentionally fail-fast on Zoekt (unlike legacy POST /index settleIndexPhases
 * which still attempted SCIP after Zoekt failure) so passed OW steps are not
 * re-run and SCIP never starts without a successful Zoekt build.
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

        // Fail-fast: do not start SCIP if Zoekt fails.
        await step.run({ name: "zoekt", retryPolicy: indexRetryPolicy }, () =>
          wls("zoekt", () => codesearchIndexZoekt(auth)),
        )

        logMilestone("repository-index.zoekt.done", {
          repositoryId: input.repositoryId,
        })

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

        await Promise.all(
          languages.languagesToIndex.map((lang) =>
            step.run(
              {
                name: `scip:${lang}`,
                retryPolicy: indexRetryPolicy,
              },
              () =>
                wls(`scip:${lang}`, () =>
                  codesearchIndexScipLang(
                    auth,
                    lang,
                    languages.detectedLanguages,
                  ),
                ),
            ),
          ),
        )

        await step.run(
          { name: "merge-scip", retryPolicy: indexRetryPolicy },
          () =>
            wls("merge-scip", () =>
              codesearchIndexMergeScip(auth, languages.detectedLanguages),
            ),
        )

        logMilestone("repository-index.merge-scip.done", {
          repositoryId: input.repositoryId,
        })

        await step.run({ name: "publish-workspace-index" }, () =>
          wls("publish-workspace-index", () =>
            publishWorkspaceIndexAfterCodesearch({
              orgId: input.orgId,
              repositoryId: input.repositoryId,
              indexedSha: checkout.targetHash,
            }),
          ),
        )

        return {
          indexedAt: new Date().toISOString(),
          targetHash: checkout.targetHash,
          ingestMode: checkout.ingestMode,
          changedPaths: checkout.changedPaths,
          deletedPaths: checkout.deletedPaths,
          renames: checkout.renames,
        }
      },
    ),
)
