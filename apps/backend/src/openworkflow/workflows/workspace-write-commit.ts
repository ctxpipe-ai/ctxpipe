import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { isConnectorMirrorPath } from "../../domain/workspaces/layout.js"
import {
  noOpExportUsesResolvedTip,
  planMigrationExport,
} from "../../domain/workspaces/migration-export.js"
import {
  filesForWorkspaceWriteKind,
  shouldEnqueueBootstrapAfterExport,
} from "../../domain/workspaces/write-commit-files.js"
import {
  executeWorkspaceWriteCommit,
  planWorkspaceWriteCommit,
} from "../../domain/workspaces/write-runner.js"
import {
  githubRepoFullNameFromWorkspaceUrl,
  writeStatusFromGithubProbeError,
} from "../../domain/workspaces/write-status.js"
import { loadMigrationExportSource } from "../../models/workspace-export.js"
import {
  getWorkspaceById,
  listLinkedRepositories,
  persistResolvedDesiredSha,
  persistWriteStatus,
} from "../../models/workspaces.js"
import {
  resolveGithubDefaultBranch,
  resolveWorkspaceRepositoryTip,
} from "../../routes/webhooks/github/github-workspace-tip.js"
import {
  commitFiles,
  getFileContent,
  listFilesInTree,
} from "../../services/github/installation-write-client.js"
import { runWorkflowWithWorkerWake } from "../client.js"
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

        const github = {
          orgId: input.orgId,
          repositoryName: repoName,
          env,
          githubConnectionId: workspace.githubConnectionId ?? undefined,
          branch: defaultBranch,
        }
        const linked = await listLinkedRepositories(workspace.id)
        const linkedUrls = linked.map((row) => row.gitUrl)
        const existing = new Map<string, string>()

        let exportPlan: ReturnType<typeof planMigrationExport> | undefined
        if (input.kind === "migration_export") {
          const source = await loadMigrationExportSource()
          const tree = await listFilesInTree(github)
          const knowledgeFiles: Array<{ path: string; content: string }> = []
          for (const entry of tree) {
            if (!entry.path.endsWith(".md")) continue
            if (isConnectorMirrorPath(entry.path)) continue
            if (
              !entry.path.startsWith("knowledge/") &&
              !entry.path.startsWith("repositories/")
            ) {
              continue
            }
            const content = await getFileContent({
              ...github,
              path: entry.path,
            })
            if (content == null) continue
            knowledgeFiles.push({ path: entry.path, content })
            existing.set(entry.path, content)
          }
          exportPlan = planMigrationExport({
            workspaceId: workspace.id,
            firstWorkspaceId: source.firstWorkspaceId,
            workspaceByRepositoryId: source.workspaceByRepositoryId,
            objects: source.objects,
            claims: source.claims,
            existingKnowledge: knowledgeFiles,
            linkedUrls,
          })
        } else if (input.kind === "bootstrap") {
          for (const path of [
            "AGENTS.md",
            ".agents/skills/ctxpipe-knowledge/SKILL.md",
          ]) {
            const content = await getFileContent({ ...github, path })
            if (content != null) existing.set(path, content)
          }
        }

        const files = filesForWorkspaceWriteKind({
          kind: input.kind,
          displayName: workspace.displayName,
          linkedUrls,
          existing,
          exportPlan,
        })
        for (const file of files) {
          if (existing.has(file.path)) continue
          const content = await getFileContent({ ...github, path: file.path })
          if (content != null) existing.set(file.path, content)
        }

        if (
          input.kind === "migration_export" &&
          exportPlan &&
          !exportPlan.wouldChange
        ) {
          const tip = await resolveWorkspaceRepositoryTip({
            orgId: input.orgId,
            githubConnectionId: workspace.githubConnectionId,
            workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
            env,
          })
          const noOp = noOpExportUsesResolvedTip(false, tip ?? "")
          if (noOp.commit === false && noOp.exportSha) {
            await persistResolvedDesiredSha({
              workspaceId: workspace.id,
              resolvedTip: noOp.exportSha,
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
          void runWorkflowWithWorkerWake(workspaceWriteCommit.spec, {
            orgId: input.orgId,
            workspaceId: workspace.id,
            kind: "bootstrap" as const,
            defaultBranch,
          }).catch(() => undefined)
          return {
            committed: false,
            reason: "no_changes" as const,
            exportSha: tip,
          }
        }

        const plan = planWorkspaceWriteCommit({
          files,
          existing,
          writeStatus: workspace.writeStatus,
          jobGeneration: workspace.desiredGeneration,
          desiredGeneration: workspace.desiredGeneration,
          jobWorkspaceUrl: workspace.workspaceRepositoryUrl,
          desiredWorkspaceUrl: workspace.workspaceRepositoryUrl,
          defaultBranch,
          targetBranch: defaultBranch,
          repoName: repoName.split("/")[1] ?? repoName,
          trigger: input.kind,
        })
        let result: Awaited<ReturnType<typeof executeWorkspaceWriteCommit>>
        try {
          result = await executeWorkspaceWriteCommit({
            plan,
            commit: async (commitFilesInput, message) =>
              commitFiles({
                ...github,
                message,
                files: commitFilesInput,
              }),
          })
        } catch (error) {
          const mapped = writeStatusFromGithubProbeError(
            error && typeof error === "object"
              ? (error as { status?: number; message?: string })
              : {},
          )
          if (mapped.writeStatus === "read_only") {
            await persistWriteStatus(workspace.id, mapped)
          }
          throw error
        }
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
        if (
          shouldEnqueueBootstrapAfterExport({
            kind: input.kind,
            committed: result.committed,
            noOpExport:
              result.committed === false && result.reason === "no_changes",
          })
        ) {
          void runWorkflowWithWorkerWake(workspaceWriteCommit.spec, {
            orgId: input.orgId,
            workspaceId: workspace.id,
            kind: "bootstrap" as const,
            defaultBranch,
          }).catch(() => undefined)
        }
        return result
      }),
    )
  },
)
