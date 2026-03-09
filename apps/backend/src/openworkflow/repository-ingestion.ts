import { eq } from "drizzle-orm"
import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import { resolveRepositoryRef } from "../domain/codeIngestion/queue.js"
import { graph as codeIngestionGraph } from "../graphs/codeIngestionGraph/graph.js"

const repositoryIngestionInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  targetBranch: z.string().nullable().optional(),
})

export const repositoryIngestion = defineWorkflow(
  { name: "repository-ingestion", schema: repositoryIngestionInputSchema },
  async ({ input, step }) => {
    return withOrgDbContext(input.orgId, async () => {
      const db = getOrgDb()

      const repository = await step.run({ name: "get-repository" }, () =>
        db.query.repositories.findFirst({
          where: {
            id: { eq: input.repositoryId },
            orgId: { eq: input.orgId },
          },
        }),
      )

      const resolved = await step.run({ name: "resolve-ref" }, () =>
        resolveRepositoryRef({
          repositoryId: input.repositoryId,
          orgId: input.orgId,
          branch: input.targetBranch ?? undefined,
        }),
      )

      await step.run({ name: "ingest" }, () =>
        codeIngestionGraph.invoke({
          repositoryId: input.repositoryId,
          orgId: input.orgId,
          fromHash: repository.lastIngestedHash ?? undefined,
          targetHash: resolved.hash,
        }),
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
    })
  },
)
