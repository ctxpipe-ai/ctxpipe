import { defineWorkflow } from "openworkflow"
import { workspaceWriteJobInputSchema } from "../../domain/workspaces/write-job-intent.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import {
  createTanstackJobSandbox,
  ensureJobSandbox,
} from "../../domain/workspaces/job-sandbox.js"
import { isConnectorMirrorPath } from "../../domain/workspaces/layout.js"
import {
  completedNoOpExportSha,
  noOpExportUsesResolvedTip,
  planMigrationExport,
} from "../../domain/workspaces/migration-export.js"
import { detectSandboxProviderFromEnv } from "../../domain/workspaces/sandbox-provider.js"
import {
  destroySandboxesForWorkspace,
  getJobSandbox,
} from "../../domain/workspaces/sandbox-registry.js"
import {
  deletePathsForWorkspaceWriteKind,
  filesForWorkspaceWriteKind,
  postExportFollowUpKinds,
  shouldEnqueueBootstrapAfterExport,
} from "../../domain/workspaces/write-commit-files.js"
import {
  applyJobWorktreeIfPresent,
  missingSemanticMergeShas,
  semanticMergeTreeShas,
} from "../../domain/workspaces/write-job-agent.js"
import {
  WRITE_JOB_STATUSES,
  writeJobIntentPayload,
} from "../../domain/workspaces/write-job-intent.js"
import {
  capturedWriteParentSha,
  commitSubjectFileNames,
  executeWorkspaceWriteCommit,
  isNonFastForwardGithubError,
  livePushRecheck,
  persistJobCommitIfRemoteHasSha,
  planJobWorktree,
  planWorkspaceWriteCommit,
  semanticMergeCommitParent,
  shouldEnqueueSemanticMergeOnPushFailure,
} from "../../domain/workspaces/write-runner.js"
import {
  githubRepoFullNameFromWorkspaceUrl,
  isProtectedDefaultBranchGithubError,
  writeStatusFromGithubProbeError,
} from "../../domain/workspaces/write-status.js"
import { generateObjectId } from "../../lib/id.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import { loadMigrationExportSource } from "../../models/workspace-export.js"
import { getMigrationExportSha } from "../../models/workspace-write-jobs.js"
import {
  getWorkspaceById,
  getWriteJobCommitSha,
  listKnowledgeUnitPaths,
  listLinkedRepositories,
  persistHydrateFailure,
  persistLastJobAt,
  persistResolvedDesiredSha,
  persistWriteJobCommitSha,
  persistWriteJobStart,
  persistWriteJobStatus,
  persistWriteStatus,
} from "../../models/workspaces.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import {
  resolveGithubDefaultBranch,
  resolveWorkspaceRepositoryTip,
} from "../../routes/webhooks/github/github-workspace-tip.js"
import {
  commitFiles,
  getCommitTimestamp,
  getFileContent,
  listFilesAtSha,
  listFilesInTree,
} from "../../services/github/installation-write-client.js"
import { enqueueWorkspaceHydrate } from "../enqueue-workspace-hydrate.js"

const workspaceWriteCommitInputSchema = workspaceWriteJobInputSchema

export const workspaceWriteCommit = defineWorkflow(
  { name: "workspace-write-commit", schema: workspaceWriteCommitInputSchema },
  async ({ input }) =>
    withLogger(
      createLogger({
        workflow: "workspace-write-commit",
        orgId: input.orgId,
        workspaceId: input.workspaceId,
      }),
      async () => {
        const env = parseEnv(process.env as Record<string, string | undefined>)
        const org = await getSystemDb().query.organizations.findFirst({
          where: { id: { eq: input.orgId } },
        })
        if (!org) throw new Error(`Organization not found: ${input.orgId}`)

        return withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
          const orgSql = <T>(fn: () => Promise<T>) =>
            withOrgDbContext(input.orgId, fn)
          const jobId = input.jobId ?? generateObjectId("wjob")
          try {
            const started = await orgSql(async () => {
              const workspace = await getWorkspaceById(input.workspaceId)
              if (!workspace) throw new Error("Workspace not found")
              const jobGeneration =
                input.jobGeneration ?? workspace.desiredGeneration
              const jobWorkspaceUrl =
                input.jobWorkspaceUrl ?? workspace.workspaceRepositoryUrl
              const jobDesiredSha =
                input.jobDesiredSha !== undefined
                  ? input.jobDesiredSha
                  : workspace.desiredSha
              await persistWriteJobStart({
                id: jobId,
                workspaceId: workspace.id,
                kind: input.kind,
                generation: jobGeneration,
                desiredSha: jobDesiredSha,
                payload: writeJobIntentPayload({
                  kind: input.kind,
                  defaultBranch: input.defaultBranch,
                  linkAction: input.linkAction,
                  linkGitUrl: input.linkGitUrl,
                  jobWorkspaceUrl,
                  conflictParentSha: input.conflictParentSha,
                  remoteTipSha: input.remoteTipSha,
                  mergeFiles: input.mergeFiles,
                  mergeDeletePaths: input.mergeDeletePaths,
                }),
              })
              await persistLastJobAt(workspace.id)
              const recordedCommit = await getWriteJobCommitSha(jobId)
              return {
                workspace,
                jobGeneration,
                jobWorkspaceUrl,
                jobDesiredSha,
                recordedCommit,
              }
            })
            const {
              workspace,
              jobGeneration,
              jobWorkspaceUrl,
              jobDesiredSha,
              recordedCommit,
            } = started
            if (
              jobDesiredSha &&
              persistJobCommitIfRemoteHasSha({
                recordedCommit,
                remoteSha: jobDesiredSha,
              }) === "skip_push_and_hydrate"
            ) {
              await orgSql(() =>
                persistWriteJobStatus(jobId, WRITE_JOB_STATUSES.completed),
              )
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
            const repoName = githubRepoFullNameFromWorkspaceUrl(jobWorkspaceUrl)
            if (!repoName) {
              await orgSql(() =>
                persistWriteJobStatus(jobId, WRITE_JOB_STATUSES.paused),
              )
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
              return {
                committed: false,
                reason: "default_branch_unknown" as const,
              }
            }

            const github = {
              orgId: input.orgId,
              repositoryName: repoName,
              env,
              githubConnectionId: workspace.githubConnectionId ?? undefined,
              branch: defaultBranch,
            }
            const capturedParent = capturedWriteParentSha(jobDesiredSha)
            const parentSha =
              semanticMergeCommitParent({
                kind: input.kind,
                capturedParentSha: capturedParent,
                remoteTipSha: input.remoteTipSha ?? null,
              }) ?? capturedParent
            const githubAtParent = {
              ...github,
              branch: parentSha ?? defaultBranch,
            }
            const linked = await orgSql(() =>
              listLinkedRepositories(workspace.id),
            )
            const linkedUrls = linked.map((row) => row.gitUrl)
            const existing = new Map<string, string>()

            let exportPlan:
              | Awaited<ReturnType<typeof planMigrationExport>>
              | undefined
            if (
              input.kind === "migration_export" ||
              input.kind === "extract_ingest"
            ) {
              const source = await orgSql(() => loadMigrationExportSource())
              const tree = parentSha
                ? await listFilesAtSha({ ...github, sha: parentSha })
                : await listFilesInTree(github)
              const knowledgeFiles: Array<{ path: string; content: string }> =
                []
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
                  ...githubAtParent,
                  path: entry.path,
                })
                if (content == null) continue
                knowledgeFiles.push({ path: entry.path, content })
                existing.set(entry.path, content)
              }
              const recordedExportSha =
                input.kind === "extract_ingest"
                  ? await orgSql(() => getMigrationExportSha(workspace.id))
                  : null
              exportPlan = await planMigrationExport({
                workspaceId: workspace.id,
                firstWorkspaceId: source.firstWorkspaceId,
                workspaceByRepositoryId: source.workspaceByRepositoryId,
                objects: source.objects,
                claims: source.claims,
                existingKnowledge: knowledgeFiles,
                linkedUrls,
                workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
                repositoryGitUrlById: source.repositoryGitUrlById,
                stampImportKey:
                  input.kind === "migration_export" || !recordedExportSha,
              })
            } else if (input.kind === "bootstrap") {
              for (const path of [
                "AGENTS.md",
                ".agents/skills/ctxpipe-knowledge/SKILL.md",
              ]) {
                const content = await getFileContent({
                  ...githubAtParent,
                  path,
                })
                if (content != null) existing.set(path, content)
              }
            } else if (
              input.kind === "claims_upgrade" ||
              input.kind === "valid_from_persist" ||
              input.kind === "rename_rewrite" ||
              input.kind === "ops_folder_map" ||
              input.kind === "import_key_cleanup"
            ) {
              const tree = parentSha
                ? await listFilesAtSha({ ...github, sha: parentSha })
                : await listFilesInTree(github)
              for (const entry of tree) {
                if (!entry.path.endsWith(".md")) continue
                if (
                  input.kind === "ops_folder_map" &&
                  entry.path !== "AGENTS.md"
                ) {
                  continue
                }
                if (
                  input.kind !== "ops_folder_map" &&
                  !entry.path.startsWith("knowledge/")
                ) {
                  continue
                }
                const content = await getFileContent({
                  ...githubAtParent,
                  path: entry.path,
                })
                if (content != null) existing.set(entry.path, content)
              }
            } else if (input.kind === "semantic_merge") {
              const tipSha = input.remoteTipSha ?? parentSha
              const tree = tipSha
                ? await listFilesAtSha({ ...github, sha: tipSha })
                : await listFilesInTree(github)
              for (const entry of tree) {
                const content = await getFileContent({
                  ...github,
                  branch: tipSha ?? defaultBranch,
                  path: entry.path,
                })
                if (content != null) existing.set(entry.path, content)
              }
            } else if (input.kind === "link_unlink") {
              const tree = parentSha
                ? await listFilesAtSha({ ...github, sha: parentSha })
                : await listFilesInTree(github)
              for (const entry of tree) {
                if (
                  !entry.path.startsWith("repositories/") ||
                  !entry.path.endsWith(".md")
                ) {
                  continue
                }
                const content = await getFileContent({
                  ...githubAtParent,
                  path: entry.path,
                })
                if (content != null) existing.set(entry.path, content)
              }
            }

            const linkChange =
              input.kind === "link_unlink" &&
              input.linkAction &&
              input.linkGitUrl
                ? { action: input.linkAction, gitUrl: input.linkGitUrl }
                : undefined
            const previousPaths =
              input.kind === "rename_rewrite"
                ? await orgSql(() => listKnowledgeUnitPaths(workspace.id))
                : []
            const introducingCommitTimestamp = parentSha
              ? ((await getCommitTimestamp({ ...github, sha: parentSha })) ??
                undefined)
              : undefined
            const plannedFiles = filesForWorkspaceWriteKind({
              kind: input.kind,
              displayName: workspace.displayName,
              linkedUrls,
              existing,
              exportPlan,
              linkChange,
              workspaceId: workspace.id,
              introducingCommitTimestamp,
              previousPaths,
              mergeFiles: input.mergeFiles,
            })
            const plannedDeletes = deletePathsForWorkspaceWriteKind({
              kind: input.kind,
              linkedUrls,
              linkChange,
              mergeDeletePaths: input.mergeDeletePaths,
            })
            const mergeTrees =
              input.kind === "semantic_merge"
                ? semanticMergeTreeShas({
                    conflictParentSha: input.conflictParentSha,
                    remoteTipSha: input.remoteTipSha,
                  })
                : null
            const mergeShas = mergeTrees
              ? [mergeTrees.conflictParentSha, mergeTrees.remoteTipSha]
              : []
            let existingSandbox = getJobSandbox(workspace.id)
            if (
              existingSandbox &&
              input.kind === "semantic_merge" &&
              mergeShas.length > 0
            ) {
              const missing = await missingSemanticMergeShas({
                exec: existingSandbox.exec,
                shas: mergeShas,
              })
              if (missing.length > 0) {
                await destroySandboxesForWorkspace(workspace.id, "job")
                if (getJobSandbox(workspace.id)) {
                  throw new Error(
                    "cannot refresh job sandbox for semantic merge",
                  )
                }
                existingSandbox = null
              }
            }
            const sandbox = await ensureJobSandbox({
              orgId: input.orgId,
              workspaceId: workspace.id,
              desiredUrl: jobWorkspaceUrl,
              desiredSha: parentSha,
              desiredGeneration: jobGeneration,
              existing: existingSandbox,
              create: async (sandboxId, hooks) =>
                createTanstackJobSandbox({
                  sandboxId,
                  storedProvider: hooks.storedProvider,
                  persistProviderId: hooks.persistLive,
                  abandonCreated: hooks.abandon,
                  gitUrl: jobWorkspaceUrl,
                  ref:
                    input.kind === "semantic_merge"
                      ? defaultBranch
                      : (parentSha ?? defaultBranch),
                  fetchShas: input.kind === "semantic_merge" ? mergeShas : [],
                  cloneToken:
                    (await getRepoReadCloneToken(input.orgId, env, {
                      githubConnectionId:
                        workspace.githubConnectionId ?? undefined,
                      repoFullName: repoName,
                    })) ?? null,
                }),
            })
            const prepared = await applyJobWorktreeIfPresent({
              worktree,
              kind: input.kind,
              files: plannedFiles,
              deletePaths: plannedDeletes,
              sandbox,
              conflictParentSha: mergeTrees
                ? mergeTrees.conflictParentSha
                : (input.conflictParentSha ?? parentSha),
              remoteTipSha: mergeTrees
                ? mergeTrees.remoteTipSha
                : input.remoteTipSha,
            })
            const files = prepared.files
            const deletePaths = prepared.deletePaths
            log.set({ writeVia: prepared.via })
            for (const file of files) {
              if (existing.has(file.path)) continue
              const content = await getFileContent({
                ...githubAtParent,
                path: file.path,
              })
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
                workspaceRepositoryUrl: jobWorkspaceUrl,
                env,
              })
              const noOp = noOpExportUsesResolvedTip(false, tip ?? "")
              const exportSha = completedNoOpExportSha(noOp)
              if (exportSha) {
                await orgSql(async () => {
                  await persistWriteJobCommitSha(jobId, exportSha)
                  await persistResolvedDesiredSha({
                    workspaceId: workspace.id,
                    resolvedTip: exportSha,
                    expectedGeneration: jobGeneration,
                    expectedUrl: jobWorkspaceUrl,
                    expectedDesiredSha: jobDesiredSha,
                  })
                })
                await enqueueWorkspaceHydrate(
                  {
                    orgId: input.orgId,
                    workspaceId: workspace.id,
                    defaultBranch,
                  },
                  { error: (err) => getLogger().error(err) },
                )
              }
              void enqueuePostExportWriteJobs({
                orgId: input.orgId,
                workspaceId: workspace.id,
                defaultBranch,
                jobGeneration,
                jobWorkspaceUrl,
                jobDesiredSha,
                kinds: postExportFollowUpKinds({
                  kind: input.kind,
                  committed: false,
                  noOpExport: true,
                }),
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
              jobGeneration,
              desiredGeneration: workspace.desiredGeneration,
              jobWorkspaceUrl,
              desiredWorkspaceUrl: workspace.workspaceRepositoryUrl,
              defaultBranch,
              targetBranch: defaultBranch,
              repoName: repoShortName,
              trigger: input.kind,
              llmSubject,
              kind: input.kind,
            })
            const live = await orgSql(() => getWorkspaceById(input.workspaceId))
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
              jobGeneration,
              desiredGeneration: live.desiredGeneration,
              jobWorkspaceUrl,
              desiredWorkspaceUrl: live.workspaceRepositoryUrl,
              defaultBranch: liveDefaultBranch,
              targetBranch: defaultBranch,
            })
            if (!recheck.push) {
              await orgSql(() =>
                persistWriteJobStatus(
                  jobId,
                  recheck.reason === "paused"
                    ? WRITE_JOB_STATUSES.paused
                    : WRITE_JOB_STATUSES.failed,
                ),
              )
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
                    expectedParentSha: parentSha ?? undefined,
                  }),
              })
            } catch (error) {
              const probe =
                error && typeof error === "object"
                  ? (error as { status?: number; message?: string })
                  : {}
              if (isProtectedDefaultBranchGithubError(probe)) {
                await orgSql(() =>
                  persistWriteJobStatus(jobId, WRITE_JOB_STATUSES.paused),
                )
                return { committed: false, reason: "paused" as const }
              }
              const mapped = writeStatusFromGithubProbeError(probe)
              if (mapped.writeStatus === "read_only") {
                await orgSql(async () => {
                  await persistWriteStatus(workspace.id, mapped, input.orgId)
                  await persistWriteJobStatus(jobId, WRITE_JOB_STATUSES.paused)
                })
                return { committed: false, reason: "paused" as const }
              }
              const nonFastForward = isNonFastForwardGithubError(probe)
              if (
                shouldEnqueueSemanticMergeOnPushFailure({
                  kind: input.kind,
                  nonFastForward,
                  capturedParentSha: capturedParent,
                })
              ) {
                const tip = await resolveWorkspaceRepositoryTip({
                  orgId: input.orgId,
                  githubConnectionId: workspace.githubConnectionId,
                  workspaceRepositoryUrl: jobWorkspaceUrl,
                  env,
                })
                if (capturedParent && tip && capturedParent !== tip) {
                  const { enqueueWorkspaceWriteCommit } = await import(
                    "../enqueue-workspace-write-commit.js"
                  )
                  void enqueueWorkspaceWriteCommit(
                    {
                      orgId: input.orgId,
                      workspaceId: workspace.id,
                      kind: "semantic_merge",
                      defaultBranch,
                      jobGeneration,
                      jobWorkspaceUrl,
                      jobDesiredSha: null,
                      conflictParentSha: capturedParent,
                      remoteTipSha: tip,
                      mergeFiles: files,
                      mergeDeletePaths: deletePaths,
                    },
                    { error: () => undefined },
                  ).catch(() => undefined)
                }
              }
              throw error
            }
            if (result.committed) {
              await orgSql(async () => {
                await persistWriteJobCommitSha(jobId, result.commitSha)
                await persistResolvedDesiredSha({
                  workspaceId: workspace.id,
                  resolvedTip: result.commitSha,
                  expectedGeneration: jobGeneration,
                  expectedUrl: jobWorkspaceUrl,
                  expectedDesiredSha:
                    input.kind === "semantic_merge"
                      ? live.desiredSha
                      : jobDesiredSha,
                })
              })
              await enqueueWorkspaceHydrate(
                {
                  orgId: input.orgId,
                  workspaceId: workspace.id,
                  defaultBranch,
                },
                { error: (err) => getLogger().error(err) },
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
              void enqueuePostExportWriteJobs({
                orgId: input.orgId,
                workspaceId: workspace.id,
                defaultBranch,
                jobGeneration,
                jobWorkspaceUrl,
                jobDesiredSha,
                kinds: postExportFollowUpKinds({
                  kind: input.kind,
                  committed: result.committed,
                  noOpExport:
                    result.committed === false &&
                    result.reason === "no_changes",
                }),
              }).catch(() => undefined)
            }
            return result
          } catch (error) {
            try {
              await orgSql(() =>
                persistWriteJobStatus(jobId, WRITE_JOB_STATUSES.failed),
              )
            } catch {
              // Job row may not exist yet if persistWriteJobStart failed.
            }
            try {
              await orgSql(() =>
                persistHydrateFailure({
                  workspaceId: input.workspaceId,
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
              )
            } catch {
              // Persist is best-effort; OpenWorkflow still records the failed run.
            }
            throw error
          }
        })
      },
    ),
)

async function enqueuePostExportWriteJobs(input: {
  orgId: string
  workspaceId: string
  defaultBranch: string
  jobGeneration: number
  jobWorkspaceUrl: string
  jobDesiredSha: string | null | undefined
  kinds: ReadonlyArray<"bootstrap" | "import_key_cleanup">
}): Promise<void> {
  if (input.kinds.length === 0) return
  const { enqueueWorkspaceWriteCommit } = await import(
    "../enqueue-workspace-write-commit.js"
  )
  for (const kind of input.kinds) {
    await enqueueWorkspaceWriteCommit(
      {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        kind,
        defaultBranch: input.defaultBranch,
        jobGeneration: input.jobGeneration,
        jobWorkspaceUrl: input.jobWorkspaceUrl,
        jobDesiredSha: input.jobDesiredSha,
      },
      { error: () => undefined },
    )
  }
}
