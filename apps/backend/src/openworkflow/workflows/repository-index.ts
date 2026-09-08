import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  codesearchIndexCloneCheckout,
  codesearchIndexDetectLanguages,
  codesearchIndexMergeScip,
  codesearchIndexScipLang,
  codesearchIndexZoekt,
} from "../../domain/codeIngestion/codesearchIndexPhases.js"
import { resolveRepositoryReadCredential } from "../../domain/workspaces/resolve-revision.js"
import {
  linkedRevisionSchema,
  sameLinkedReadBinding,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  isMemoryFitFailure,
  userFacingIndexingError,
} from "../../lib/memoryFitError.js"
import { getRepositoryReadBinding } from "../../models/repositories.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import {
  getLinkedReadBinding,
  persistWorkspaceIndexResult,
} from "../../models/workspaces.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { withLoggedStepAttempt } from "../withLoggedStepAttempt.js"

const repositoryIndexInputSchema = z
  .object({
    repositoryId: z.string().min(1),
    orgId: z.string().min(1),
    targetHash: z.string().min(1),
    fromHash: z.string().optional(),
    githubConnectionId: z.string().optional(),
    workspaceId: z.string().min(1).optional(),
    jobGeneration: z.number().int().optional(),
    jobWorkspaceUrl: z.string().min(1).optional(),
    revision: workspaceRevisionSchema.optional(),
    linkedRevision: linkedRevisionSchema.optional(),
  })
  .refine(
    (input) =>
      !input.revision ||
      (input.revision.access === "read" &&
        input.revision.workspaceId === input.workspaceId &&
        input.revision.sha === input.targetHash &&
        (input.jobGeneration === undefined ||
          input.revision.generation === input.jobGeneration) &&
        (input.jobWorkspaceUrl === undefined ||
          input.revision.remote.url === input.jobWorkspaceUrl) &&
        (input.githubConnectionId === undefined ||
          input.githubConnectionId === input.revision.remote.connectionId)),
    "Repository index input must describe one workspace revision",
  )
  .refine(
    (input) =>
      !input.workspaceId ||
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.targetHash),
    "Workspace indexing requires an immutable commit SHA",
  )
  .refine(
    (input) =>
      !input.workspaceId ||
      Boolean(input.revision) !== Boolean(input.linkedRevision),
    "Workspace indexing requires exactly one captured revision",
  )
  .refine(
    (input) =>
      !input.linkedRevision ||
      (input.linkedRevision.owner.access === "read" &&
        input.linkedRevision.owner.workspaceId === input.workspaceId &&
        input.linkedRevision.repositoryId === input.repositoryId &&
        input.linkedRevision.sha === input.targetHash &&
        (input.githubConnectionId === undefined ||
          input.githubConnectionId ===
            input.linkedRevision.remote.connectionId)),
    "Linked indexing must use its captured revision",
  )

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
        const repository = await getRepositoryReadBinding(
          input.orgId,
          input.repositoryId,
        )
        const targetRevision = input.linkedRevision ?? input.revision
        if (
          input.linkedRevision &&
          !(await withOrgDbContext(input.orgId, async () =>
            sameLinkedReadBinding(
              await getLinkedReadBinding(input.linkedRevision!.linkId),
              input.linkedRevision!,
            ),
          ))
        )
          throw new Error("Linked revision changed before index admission")
        if (
          !repository ||
          (targetRevision &&
            normalizeWorkspaceRepositoryUrl(repository.gitUrl) !==
              normalizeWorkspaceRepositoryUrl(targetRevision.remote.url))
        )
          throw new Error(
            "Index repository does not match the captured revision",
          )
        const auth = {
          repositoryId: input.repositoryId,
          orgId: input.orgId,
          ...(input.workspaceId
            ? {
                workspaceId: input.workspaceId,
                workspaceRevisions: [
                  { repositoryId: input.repositoryId, sha: input.targetHash },
                ],
              }
            : {}),
        }
        const wls = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
          withLoggedStepAttempt(
            name,
            {
              workflow: "repository-index",
              repositoryId: input.repositoryId,
              orgId: input.orgId,
            },
            async () => {
              try {
                return await fn()
              } catch (error) {
                const revision = input.revision
                if (revision)
                  await withOrgDbContext(input.orgId, () =>
                    persistWorkspaceIndexResult({
                      revision,
                      result: {
                        kind: "failed",
                        message:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      },
                    }),
                  )
                throw error
              }
            },
          )

        logMilestone("repository-index.start", {
          repositoryId: input.repositoryId,
          targetHash: input.targetHash,
        })

        const env = parseEnv(process.env as Record<string, string | undefined>)
        const githubToken = await wls("resolve-github-token", () =>
          resolveRepositoryReadCredential({
            orgId: input.orgId,
            env,
            remote: targetRevision?.remote ?? {
              url: repository.gitUrl,
              connectionId:
                input.githubConnectionId ?? repository.githubConnectionId,
            },
          }),
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

        const zoektResult = zoektStepResult(
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
