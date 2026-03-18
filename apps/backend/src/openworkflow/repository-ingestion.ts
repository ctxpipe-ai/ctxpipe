import { eq } from "drizzle-orm"
import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../auth/withAuth.js"
import { getOrgDb, getSystemDb, withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import { resolveRepositoryRef } from "../domain/codeIngestion/queue.js"
import { graph as codeIngestionGraph } from "../graphs/codeIngestionGraph/graph.js"
import {
  getLangfuseHandler,
  runWithLangfuseContext,
} from "../observability/langfuse.js"
import { createLogger, getLogger, withLogger } from "../observability/logger.js"

const repositoryIngestionInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  targetBranch: z.string().nullable().optional(),
})

export const repositoryIngestion = defineWorkflow(
  { name: "repository-ingestion", schema: repositoryIngestionInputSchema },
  async ({ input, step }) =>
    withLogger(
      createLogger({
        workflow: "repository-ingestion",
        repositoryId: input.repositoryId,
        orgId: input.orgId,
      }),
      async () => {
        const logger = getLogger()
        logger.info("repository ingestion started", {
          targetBranch: input.targetBranch ?? null,
        })
        const org = await getSystemDb().query.organizations.findFirst({
          where: { id: { eq: input.orgId } },
        })

        if (!org) {
          logger.warn("repository ingestion organization was not found", {
            orgId: input.orgId,
          })
          throw new Error(`Organization not found: ${input.orgId}`)
        }
        logger.set({ orgSlug: org.slug })

        return withOrgIdContext({ id: org.id, slug: org.slug }, () =>
          withOrgDbContext(input.orgId, async () => {
            const db = getOrgDb()

            const repository = await step.run({ name: "get-repository" }, () =>
              db.query.repositories.findFirst({
                where: {
                  id: { eq: input.repositoryId },
                  orgId: { eq: input.orgId },
                },
              }),
            )
            if (!repository) {
              logger.warn("repository ingestion repository was not found", {
                repositoryId: input.repositoryId,
              })
              throw new Error(`Repository not found: ${input.repositoryId}`)
            }
            logger.set({
              repositoryName: repository.name,
              lastIngestedHash: repository.lastIngestedHash ?? null,
            })

            const resolved = await step.run({ name: "resolve-ref" }, () =>
              resolveRepositoryRef({
                repositoryId: input.repositoryId,
                orgId: input.orgId,
                branch: input.targetBranch ?? undefined,
              }),
            )
            logger.info("repository ingestion ref resolved", {
              sourceBranch: resolved.branch,
              targetHash: resolved.hash,
            })

            await step.run({ name: "ingest" }, () =>
              runWithLangfuseContext(
                {
                  sessionId: input.repositoryId,
                  tags: ["repository-ingestion"],
                },
                () =>
                  codeIngestionGraph.invoke(
                    {
                      repositoryId: input.repositoryId,
                      orgId: input.orgId,
                      fromHash: repository.lastIngestedHash ?? undefined,
                      targetHash: resolved.hash,
                    },
                    {
                      recursionLimit: 1000,
                      callbacks: [getLangfuseHandler()],
                    },
                  ),
              ),
            )
            logger.info("repository ingestion graph completed", {
              targetHash: resolved.hash,
            })

            await step.run({ name: "mark-success" }, () =>
              db
                .update(repositories)
                .set({
                  indexReady: true,
                  lastIngestedHash: resolved.hash,
                  updatedAt: new Date(),
                })
                .where(eq(repositories.id, input.repositoryId)),
            )
            logger.info("repository ingestion marked repository ready", {
              repositoryId: input.repositoryId,
              targetHash: resolved.hash,
            })

            return {
              repositoryId: input.repositoryId,
              targetHash: resolved.hash,
              sourceBranch: resolved.branch,
            }
          }),
        )
      },
    ),
)
