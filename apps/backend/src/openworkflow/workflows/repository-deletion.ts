import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { deleteRepositoryWithCleanup } from "../../domain/repositoryDeletion.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { withGraphClient } from "../../platform/graph/client.js"

const repositoryDeletionInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
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

        return withOrgIdContext({ id: org.id, slug: org.slug }, async () =>
          withOrgDbContext(input.orgId, async () =>
            withGraphClient({ orgId: org.id, orgSlug: org.slug }, async () => {
              const deleted = await step.run({ name: "delete-repository" }, () =>
                deleteRepositoryWithCleanup({
                  orgId: input.orgId,
                  repositoryId: input.repositoryId,
                }),
              )

              logWorkflowMilestone("repository-deletion.complete", {
                repositoryId: input.repositoryId,
                deleted,
              })

              return { deleted }
            }),
          ),
        )
      },
    ),
)
