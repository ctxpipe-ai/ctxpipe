import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { projectWorkspaceCommits } from "../../domain/workspaces/project-workspace-commits.js"

const workspaceCommitProjectionInputSchema = z.object({
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
})

export const workspaceCommitProjection = defineWorkflow(
  {
    name: "workspace-commit-projection",
    schema: workspaceCommitProjectionInputSchema,
  },
  async ({ input }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) throw new Error(`Organization not found: ${input.orgId}`)
    return withOrgIdContext({ id: org.id, slug: org.slug }, () =>
      projectWorkspaceCommits({
        workspaceId: input.workspaceId,
        env,
      }),
    )
  },
)
