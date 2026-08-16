import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import { isConnectorMirrorPath } from "../../domain/workspaces/layout.js"
import {
  noOpExportUsesResolvedTip,
  planMigrationExport,
} from "../../domain/workspaces/migration-export.js"
import { detectSandboxProviderFromEnv } from "../../domain/workspaces/sandbox-provider.js"
import { getJobSandbox } from "../../domain/workspaces/sandbox-registry.js"
import {
  deletePathsForWorkspaceWriteKind,
  filesForWorkspaceWriteKind,
  shouldEnqueueBootstrapAfterExport,
} from "../../domain/workspaces/write-commit-files.js"
import { applyJobWorktreeIfPresent } from "../../domain/workspaces/write-job-agent.js"
import {
  commitSubjectFileNames,
  executeWorkspaceWriteCommit,
  isNonFastForwardGithubError,
  livePushRecheck,
  persistJobCommitIfRemoteHasSha,
  planAfterMechanicalPushFailure,
  planJobWorktree,
  planWorkspaceWriteCommit,
} from "../../domain/workspaces/write-runner.js"
import {
  githubRepoFullNameFromWorkspaceUrl,
  writeStatusFromGithubProbeError,
} from "../../domain/workspaces/write-status.js"
import { generateObjectId } from "../../lib/id.js"
import { loadMigrationExportSource } from "../../models/workspace-export.js"
import {
  getWorkspaceById,
  getWriteJobCommitSha,
  listKnowledgeUnitPaths,
  listLinkedRepositories,
  persistLastJobAt,
  persistResolvedDesiredSha,
  persistWriteJobCommitSha,
  persistWriteJobStart,
  persistWriteStatus,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
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
  kind: z.enum([
    "migration_export",
    "extract_ingest",
    "connector_mirror",
    "claims_upgrade",
    "rename_rewrite",
    "valid_from_persist",
    "semantic_merge",
    "ops_folder_map",
    "bootstrap",
    "link_unlink",
  ]),
  defaultBranch: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  linkAction: z.enum(["link", "unlink"]).optional(),
  linkGitUrl: z.string().min(1).optional(),
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
        const jobId = input.jobId ?? generateObjectId("wjob")
        await persistWriteJobStart({
          id: jobId,
          workspaceId: workspace.id,
          kind: input.kind,
          generation: workspace.desiredGeneration,
          desiredSha: workspace.desiredSha,
        })
        await persistLastJobAt(workspace.id)
        const recordedCommit = await getWriteJobCommitSha(jobId)
        if (
          workspace.desiredSha &&
          persistJobCommitIfRemoteHasSha({
            recordedCommit,
            remoteSha: workspace.desiredSha,
          }) === "skip_push_and_hydrate"
        ) {
          return {
            committed: false,
            reason: "already_pushed" as const,
            commitSha: recordedCommit,
          }
        }
        const worktree = planJobWorktree({
          jobId,
          kind: input.kind,
          writeStatus: workspace.writeStatus,
          runningJobCount: 0,
          provider: detectSandboxProviderFromEnv({}),
        })
        const log = getLogger()
        log.set({
          workspaceId: workspace.id,
          jobId,
          kind: input.kind,
          worktree: worktree.spawn ? worktree.worktree : worktree.reason,
        })
        log.info("plan workspace write job worktree")
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
        if (
          input.kind === "migration_export" ||
          input.kind === "extract_ingest"
        ) {
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
        } else if (
          input.kind === "claims_upgrade" ||
          input.kind === "valid_from_persist" ||
          input.kind === "rename_rewrite" ||
          input.kind === "ops_folder_map"
        ) {
          const tree = await listFilesInTree(github)
          for (const entry of tree) {
            if (!entry.path.endsWith(".md")) continue
            if (input.kind === "ops_folder_map" && entry.path !== "AGENTS.md") {
              continue
            }
            if (
              input.kind !== "ops_folder_map" &&
              !entry.path.startsWith("knowledge/")
            ) {
              continue
            }
            const content = await getFileContent({
              ...github,
              path: entry.path,
            })
            if (content != null) existing.set(entry.path, content)
          }
        } else if (input.kind === "link_unlink") {
          const tree = await listFilesInTree(github)
          for (const entry of tree) {
            if (
              !entry.path.startsWith("repositories/") ||
              !entry.path.endsWith(".md")
            ) {
              continue
            }
            const content = await getFileContent({
              ...github,
              path: entry.path,
            })
            if (content != null) existing.set(entry.path, content)
          }
        }

        const linkChange =
          input.kind === "link_unlink" && input.linkAction && input.linkGitUrl
            ? { action: input.linkAction, gitUrl: input.linkGitUrl }
            : undefined
        const previousPaths =
          input.kind === "rename_rewrite"
            ? await listKnowledgeUnitPaths(workspace.id)
            : []
        const plannedFiles = filesForWorkspaceWriteKind({
          kind: input.kind,
          displayName: workspace.displayName,
          linkedUrls,
          existing,
          exportPlan,
          linkChange,
          workspaceId: workspace.id,
          introducingSha: workspace.desiredSha ?? undefined,
          previousPaths,
        })
        const plannedDeletes = deletePathsForWorkspaceWriteKind({
          kind: input.kind,
          linkedUrls,
          linkChange,
        })
        const prepared = await applyJobWorktreeIfPresent({
          worktree,
          kind: input.kind,
          files: plannedFiles,
          deletePaths: plannedDeletes,
          sandbox: getJobSandbox(workspace.id),
        })
        const files = prepared.files
        const deletePaths = prepared.deletePaths
        log.set({ writeVia: prepared.via })
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
              expectedDesiredSha: workspace.desiredSha,
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

        const repoShortName = repoName.split("/")[1] ?? repoName
        const llmSubject = await generateCommitSubject({
          repoName: repoShortName,
          trigger: input.kind,
          fileNames: commitSubjectFileNames(files),
        })
        const plan = planWorkspaceWriteCommit({
          files,
          deletePaths,
          existing,
          writeStatus: workspace.writeStatus,
          jobGeneration: workspace.desiredGeneration,
          desiredGeneration: workspace.desiredGeneration,
          jobWorkspaceUrl: workspace.workspaceRepositoryUrl,
          desiredWorkspaceUrl: workspace.workspaceRepositoryUrl,
          defaultBranch,
          targetBranch: defaultBranch,
          repoName: repoShortName,
          trigger: input.kind,
          llmSubject,
        })
        const live = await getWorkspaceById(input.workspaceId)
        if (!live) throw new Error("Workspace not found")
        const liveDefaultBranch =
          (await resolveGithubDefaultBranch({
            orgId: input.orgId,
            githubConnectionId: live.githubConnectionId,
            repoFullName: repoName,
            env,
          })) ?? defaultBranch
        const recheck = livePushRecheck({
          writeStatus: live.writeStatus,
          jobGeneration: workspace.desiredGeneration,
          desiredGeneration: live.desiredGeneration,
          jobWorkspaceUrl: workspace.workspaceRepositoryUrl,
          desiredWorkspaceUrl: live.workspaceRepositoryUrl,
          defaultBranch: liveDefaultBranch,
          targetBranch: defaultBranch,
        })
        if (!recheck.push) {
          return { committed: false, reason: recheck.reason }
        }
        let result: Awaited<ReturnType<typeof executeWorkspaceWriteCommit>>
        try {
          result = await executeWorkspaceWriteCommit({
            plan,
            commit: async (commitFilesInput, message, commitDeletePaths) =>
              commitFiles({
                ...github,
                message,
                files: commitFilesInput,
                deletePaths: commitDeletePaths,
              }),
          })
        } catch (error) {
          const probe =
            error && typeof error === "object"
              ? (error as { status?: number; message?: string })
              : {}
          const mapped = writeStatusFromGithubProbeError(probe)
          if (mapped.writeStatus === "read_only") {
            await persistWriteStatus(workspace.id, mapped)
          }
          if (
            planAfterMechanicalPushFailure({
              kind: input.kind,
              nonFastForward: isNonFastForwardGithubError(probe),
            }) === "enqueue_semantic_merge"
          ) {
            void runWorkflowWithWorkerWake(workspaceWriteCommit.spec, {
              orgId: input.orgId,
              workspaceId: workspace.id,
              kind: "semantic_merge" as const,
              defaultBranch,
            }).catch(() => undefined)
          }
          throw error
        }
        if (result.committed) {
          await persistWriteJobCommitSha(jobId, result.commitSha)
          await persistResolvedDesiredSha({
            workspaceId: workspace.id,
            resolvedTip: result.commitSha,
            expectedGeneration: workspace.desiredGeneration,
            expectedUrl: workspace.workspaceRepositoryUrl,
            expectedDesiredSha: workspace.desiredSha,
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
