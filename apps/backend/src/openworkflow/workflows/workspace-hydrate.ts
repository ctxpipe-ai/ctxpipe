import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import {
  hydrateIsNoop,
  hydrateKnowledgeTree,
} from "../../domain/workspaces/hydrate.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  activateHydrateProjection,
  getWorkspaceById,
  replaceWorkspaceKnowledgeProjection,
} from "../../models/workspaces.js"
import { resolveGithubDefaultBranch } from "../../routes/webhooks/github/github-workspace-tip.js"
import {
  getFileContent,
  listFilesInTree,
} from "../../services/github/installation-write-client.js"

const workspaceHydrateInputSchema = z.object({
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
})

export const workspaceHydrate = defineWorkflow(
  { name: "workspace-hydrate", schema: workspaceHydrateInputSchema },
  async ({ input }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) throw new Error(`Organization not found: ${input.orgId}`)

    return withOrgIdContext({ id: org.id, slug: org.slug }, () =>
      withOrgDbContext(input.orgId, async () => {
        const workspace = await getWorkspaceById(input.workspaceId)
        if (!workspace) throw new Error("Workspace not found")
        if (!workspace.desiredSha) {
          return { hydrated: false, reason: "desired_sha_missing" as const }
        }
        if (
          hydrateIsNoop(workspace.activeProjectionSha, workspace.desiredSha)
        ) {
          return { hydrated: false, reason: "noop" as const }
        }
        const repoName = githubRepoFullNameFromWorkspaceUrl(
          workspace.workspaceRepositoryUrl,
        )
        if (!repoName) {
          return { hydrated: false, reason: "not_github" as const }
        }
        const defaultBranch =
          input.defaultBranch ??
          (await resolveGithubDefaultBranch({
            orgId: input.orgId,
            githubConnectionId: workspace.githubConnectionId,
            repoFullName: repoName,
            env,
          }))
        if (!defaultBranch) {
          return { hydrated: false, reason: "default_branch_unknown" as const }
        }

        const tree = await listFilesInTree({
          orgId: input.orgId,
          repositoryName: repoName,
          env,
          githubConnectionId: workspace.githubConnectionId ?? undefined,
          branch: defaultBranch,
        })
        const files: Array<{ path: string; content: string }> = []
        for (const entry of tree) {
          if (!entry.path.endsWith(".md")) continue
          const content = await getFileContent({
            orgId: input.orgId,
            repositoryName: repoName,
            env,
            githubConnectionId: workspace.githubConnectionId ?? undefined,
            branch: defaultBranch,
            path: entry.path,
          })
          if (content == null) continue
          files.push({ path: entry.path, content })
        }

        const parsed = hydrateKnowledgeTree({
          workspaceId: workspace.id,
          files,
        })
        await replaceWorkspaceKnowledgeProjection({
          orgId: input.orgId,
          workspaceId: workspace.id,
          projectionSha: workspace.desiredSha,
          units: parsed.units,
        })
        const activated = await activateHydrateProjection({
          workspaceId: workspace.id,
          jobGeneration: workspace.desiredGeneration,
          jobWorkspaceUrl: workspace.workspaceRepositoryUrl,
          hydratedSha: workspace.desiredSha,
        })
        return {
          hydrated: activated,
          units: parsed.units.length,
          skipped: parsed.skipped.length,
        }
      }),
    )
  },
)
