import { eq } from "drizzle-orm"
import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../auth/withAuth.js"
import { getOrgDb, getSystemDb, withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import { resolveRepositoryRef } from "../domain/codeIngestion/queue.js"
import { graph as codeIngestionGraph } from "../graphs/codeIngestionGraph/graph.js"
import { runWithLangfuseContext } from "../observability/langfuse.js"
import { langfusePipelineCallbacks } from "../observability/langfusePipelineMetrics.js"
import { createLogger, withLogger } from "../observability/logger.js"

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
        const org = await getSystemDb().query.organizations.findFirst({
          where: { id: { eq: input.orgId } },
        })

        if (!org) {
          throw new Error(`Organization not found: ${input.orgId}`)
        }

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
              throw new Error(
                `repository-ingestion: no repository row for id=${input.repositoryId} orgId=${input.orgId} (skipping codesearch resolve-ref)`,
              )
            }

            const resolved = await step.run({ name: "resolve-ref" }, () =>
              resolveRepositoryRef({
                repositoryId: input.repositoryId,
                orgId: input.orgId,
                branch: input.targetBranch ?? undefined,
              }),
            )

            await step.run({ name: "ingest" }, () =>
              runWithLangfuseContext(
                {
                  sessionId: input.repositoryId,
                  tags: ["repository-ingestion"],
                  traceMetadata: {
                    workflow: "repository-ingestion",
                    repositoryId: input.repositoryId,
                    orgId: input.orgId,
                  },
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
                      callbacks: langfusePipelineCallbacks({
                        step: "codeIngestion.graph",
                        dimensions: {
                          repositoryId: input.repositoryId,
                          orgId: input.orgId,
                          targetHash: resolved.hash,
                        },
                      }),
                    },
                  ),
              ),
            )

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
