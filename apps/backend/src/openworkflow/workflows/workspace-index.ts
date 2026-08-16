import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import {
  ensureWorkspaceCheckout,
  findRepositoriesByNormalizedGitUrls,
  getGithubConnectionIdForRepository,
} from "../../models/repositories.js"
import {
  getWorkspaceById,
  listLinkedRepositories,
  persistIndexedSha,
  persistLinkedIndexedSha,
} from "../../models/workspaces.js"
import { repositoryIndex } from "./repository-index.js"

const workspaceIndexInputSchema = z.object({
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
  gitUrl: z.string().min(1),
  desiredSha: z.string().min(1),
  role: z.enum(["workspace", "linked"]),
  linkedId: z.string().min(1).optional(),
})

export const workspaceIndex = defineWorkflow(
  { name: "workspace-index", schema: workspaceIndexInputSchema },
  async ({ input, step }) => {
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) throw new Error(`Organization not found: ${input.orgId}`)

    return withOrgIdContext({ id: org.id, slug: org.slug }, () =>
      withOrgDbContext(input.orgId, async () => {
        const workspace = await getWorkspaceById(input.workspaceId)
        if (!workspace) return { published: false, reason: "missing" as const }
        const repos = await findRepositoriesByNormalizedGitUrls([
          normalizeWorkspaceRepositoryUrl(input.gitUrl),
        ])
        const repo = repos[0]
        if (!repo) {
          return { published: false, reason: "no_repository" as const }
        }
        const githubConnectionId = await getGithubConnectionIdForRepository({
          orgId: input.orgId,
          repositoryId: repo.id,
        })
        await ensureWorkspaceCheckout({
          repositoryId: repo.id,
          workspaceId: workspace.id,
          ref: input.desiredSha,
        })
        await step.runWorkflow(
          repositoryIndex.spec,
          {
            repositoryId: repo.id,
            orgId: input.orgId,
            targetHash: input.desiredSha,
            workspaceId: workspace.id,
            ...(githubConnectionId ? { githubConnectionId } : {}),
          },
          { name: "repository-index" },
        )
        if (input.role === "linked" && input.linkedId) {
          const linked = (await listLinkedRepositories(workspace.id)).find(
            (row) => row.id === input.linkedId,
          )
          if (!linked) {
            return { published: false, reason: "missing_linked" as const }
          }
          const published = await persistLinkedIndexedSha({
            linkedId: input.linkedId,
            workspaceId: workspace.id,
            indexedSha: input.desiredSha,
            expectedDesiredSha: input.desiredSha,
            expectedGeneration: workspace.desiredGeneration,
            expectedWorkspaceUrl: workspace.workspaceRepositoryUrl,
            expectedLinkedUrl: linked.gitUrl,
            expectedLinkedRef: linked.desiredRef,
          })
          return { published, role: input.role }
        }
        const published = await persistIndexedSha({
          workspaceId: workspace.id,
          indexedSha: input.desiredSha,
          expectedGeneration: workspace.desiredGeneration,
          expectedUrl: workspace.workspaceRepositoryUrl,
          expectedDesiredSha: input.desiredSha,
        })
        return { published, role: input.role }
      }),
    )
  },
)
