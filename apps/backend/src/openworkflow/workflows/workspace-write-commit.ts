import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { migrationExportFiles } from "../../domain/workspaces/migration-export.js"
import {
  executeWorkspaceWriteCommit,
  planWorkspaceWriteCommit,
} from "../../domain/workspaces/write-runner.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  getWorkspaceById,
  listLinkedRepositories,
  persistResolvedDesiredSha,
} from "../../models/workspaces.js"
import { resolveGithubDefaultBranch } from "../../routes/webhooks/github/github-workspace-tip.js"
import {
  commitFiles,
  getFileContent,
} from "../../services/github/installation-write-client.js"
import { enqueueWorkspaceHydrate } from "../enqueue-workspace-hydrate.js"

const workspaceWriteCommitInputSchema = z.object({
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: z.enum(["migration_export", "link_unlink", "bootstrap"]),
  defaultBranch: z.string().min(1).optional(),
})

export const workspaceWriteCommit = defineWorkflow(
  { name: "workspace-write-commit", schema: workspaceWriteCommitInputSchema },
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
        const repoName = githubRepoFullNameFromWorkspaceUrl(
          workspace.workspaceRepositoryUrl,
        )
        if (!repoName) {
          return { committed: false, reason: "not_github" as const }
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
          return { committed: false, reason: "default_branch_unknown" as const }
        }

        const linked = await listLinkedRepositories(workspace.id)
        const files = migrationExportFiles({
          imported: [],
          takenPaths: [],
          linkedUrls: linked.map((row) => row.gitUrl),
        })
        const existing = new Map<string, string>()
        for (const file of files) {
          const content = await getFileContent({
            orgId: input.orgId,
            repositoryName: repoName,
            env,
            githubConnectionId: workspace.githubConnectionId ?? undefined,
            branch: defaultBranch,
            path: file.path,
          })
          if (content != null) existing.set(file.path, content)
        }

        const plan = planWorkspaceWriteCommit({
          files,
          existing,
          writeStatus:
            workspace.writeStatus === "unknown"
              ? "writable"
              : workspace.writeStatus,
          jobGeneration: workspace.desiredGeneration,
          desiredGeneration: workspace.desiredGeneration,
          jobWorkspaceUrl: workspace.workspaceRepositoryUrl,
          desiredWorkspaceUrl: workspace.workspaceRepositoryUrl,
          defaultBranch,
          targetBranch: defaultBranch,
          repoName: repoName.split("/")[1] ?? repoName,
          trigger: input.kind,
        })
        const result = await executeWorkspaceWriteCommit({
          plan,
          commit: async (commitFilesInput, message) =>
            commitFiles({
              orgId: input.orgId,
              repositoryName: repoName,
              env,
              githubConnectionId: workspace.githubConnectionId ?? undefined,
              branch: defaultBranch,
              message,
              files: commitFilesInput,
            }),
        })
        if (result.committed) {
          await persistResolvedDesiredSha({
            workspaceId: workspace.id,
            resolvedTip: result.commitSha,
            expectedGeneration: workspace.desiredGeneration,
            expectedUrl: workspace.workspaceRepositoryUrl,
          })
          void enqueueWorkspaceHydrate(
            {
              orgId: input.orgId,
              workspaceId: workspace.id,
              defaultBranch,
            },
            { error: () => undefined },
          )
        }
        return result
      }),
    )
  },
)
