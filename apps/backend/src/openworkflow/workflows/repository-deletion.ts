import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { formatUnknownError } from "../../db/transientDbRetry.js"
import {
  applyRepositoryDeletionGraphCleanup,
  deleteRepositoryRowPostgres,
  notifyCodesearchRepositoryDeleted,
  prepareRepositoryDeletionPostgres,
} from "../../domain/repositoryDeletion.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { withGraphClient } from "../../platform/graph/client.js"
import { withLoggedStepAttempt } from "../withLoggedStepAttempt.js"

const repositoryDeletionInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  /** Optional hints so codesearch purge can run if prepare resumes as not-found. */
  repoName: z.string().min(1).optional(),
  zoektRepoId: z.number().int().positive().optional(),
})

function logWorkflowMilestone(
  step: string,
  fields: Record<string, unknown>,
): void {
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

export const repositoryDeletion = defineWorkflow(
  { name: "repository-deletion", schema: repositoryDeletionInputSchema },
  async ({ input, step }) =>
    withLogger(
      createLogger({
        workflow: "repository-deletion",
        repositoryId: input.repositoryId,
        orgId: input.orgId,
      }),
      async () => {
        const wls = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
          withLoggedStepAttempt(
            name,
            { repositoryId: input.repositoryId, orgId: input.orgId },
            fn,
          )

        logWorkflowMilestone("repository-deletion.workflow-handler-entered", {
          repositoryId: input.repositoryId,
          orgId: input.orgId,
        })

        const org = await getSystemDb().query.organizations.findFirst({
          where: { id: { eq: input.orgId } },
        })

        if (!org) {
          throw new Error(`Organization not found: ${input.orgId}`)
        }

        try {
          return await withOrgIdContext(
            { id: org.id, slug: org.slug },
            async () => {
              // Persist graphEffects in this step *before* deleting the row so a
              // crash between row delete and step-ack cannot drop claim retractions.
              const prepared = await step.run({ name: "prepare-purge" }, () =>
                wls("prepare-purge", () =>
                  withOrgDbContext(input.orgId, () =>
                    prepareRepositoryDeletionPostgres({
                      orgId: input.orgId,
                      repositoryId: input.repositoryId,
                    }),
                  ),
                ),
              )

              logWorkflowMilestone("repository-deletion.prepare-purge.done", {
                repositoryId: input.repositoryId,
                found: prepared.found,
                deletedEvidenceRows: prepared.stats.deletedEvidenceRows,
                claimsDeleted: prepared.stats.claimsDeleted,
              })

              const deleted = await step.run({ name: "delete-row" }, () =>
                wls("delete-row", () =>
                  withOrgDbContext(input.orgId, () =>
                    deleteRepositoryRowPostgres({
                      orgId: input.orgId,
                      repositoryId: input.repositoryId,
                    }),
                  ),
                ),
              )

              logWorkflowMilestone("repository-deletion.delete-row.done", {
                repositoryId: input.repositoryId,
                deleted,
              })

              await step.run({ name: "sync-graph" }, () =>
                wls("sync-graph", () =>
                  withGraphClient({ orgId: org.id, orgSlug: org.slug }, () =>
                    applyRepositoryDeletionGraphCleanup({
                      repositoryId: input.repositoryId,
                      graphEffects: prepared.graphEffects,
                    }),
                  ),
                ),
              )

              logWorkflowMilestone("repository-deletion.sync-graph.done", {
                repositoryId: input.repositoryId,
              })

              const repoName = prepared.name ?? input.repoName ?? null
              const zoektRepoId =
                prepared.zoektRepoId ?? input.zoektRepoId ?? null

              if (repoName != null && zoektRepoId != null && zoektRepoId > 0) {
                await step.run({ name: "purge-codesearch" }, () =>
                  wls("purge-codesearch", () =>
                    notifyCodesearchRepositoryDeleted({
                      orgId: input.orgId,
                      repositoryId: input.repositoryId,
                      repoName,
                      zoektRepoId,
                    }),
                  ),
                )
                logWorkflowMilestone(
                  "repository-deletion.purge-codesearch.done",
                  {
                    repositoryId: input.repositoryId,
                    zoektRepoId,
                  },
                )
              } else {
                logWorkflowMilestone(
                  "repository-deletion.purge-codesearch.skipped",
                  {
                    repositoryId: input.repositoryId,
                    reason: "missing repoName or zoektRepoId",
                  },
                )
              }

              logWorkflowMilestone("repository-deletion.complete", {
                repositoryId: input.repositoryId,
                deleted,
                found: prepared.found,
              })

              return {
                deleted,
                alreadyGone: !prepared.found && !deleted,
              }
            },
          )
        } catch (err: unknown) {
          logWorkflowMilestone("repository-deletion.failed", {
            repositoryId: input.repositoryId,
            error: formatUnknownError(err),
          })
          throw err
        }
      },
    ),
)
