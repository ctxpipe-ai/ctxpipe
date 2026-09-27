import { createHash } from "node:crypto"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { captureConnectorMirrorTarget } from "../../domain/workspaces/capture-connector-mirror.js"
import {
  getGithubPrMirrorBinding,
  patchGithubPrMirror,
} from "../../models/github-pr-mirror.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { parseGithubPrConfigYamlContent } from "../../services/github/pull-request-mirror/config-yaml.js"
import {
  captureGithubPullRequestsForConfig,
  GITHUB_PR_MIRROR_COMMIT_BATCH,
  listGithubPullRequestNumbersForConfig,
} from "../../services/github/pull-request-mirror/sync.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import { isWorkflowControlSignal } from "../isSleepSignal.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const GithubSyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  contentSyncGeneration: z.number().int().nonnegative().optional(),
  commitSha: z.string().min(1).optional(),
  launchToken: z.string().min(1).optional(),
  repositoryId: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
})

function publishedRevision<T extends { sha: string }>(
  revision: T,
  result: unknown,
): T {
  if (result && typeof result === "object" && "commitSha" in result) {
    const commitSha = (result as { commitSha?: string }).commitSha
    if (commitSha) return { ...revision, sha: commitSha }
  }
  return revision
}

export function githubPrMirrorRepoKey(repository: string): string {
  const digest = createHash("sha256")
    .update(repository, "utf8")
    .digest("hex")
    .slice(0, 16)
  return `${repository.replaceAll("/", "--")}-${digest}`
}

export function githubPrMirrorContentIdempotencyKey(input: {
  connectionId: string
  commitSha: string
  launchToken?: string
}): string {
  const base = `github-pr-mirror-content:${input.connectionId}:${input.commitSha}`
  return input.launchToken ? `${base}:launch:${input.launchToken}` : base
}

export async function enqueueGithubPrMirrorContent(input: {
  orgId: string
  connectionId: string
  commitSha: string
  launchToken?: string
}): Promise<{ id: string; status: string }> {
  const reserved = await patchGithubPrMirror({
    orgId: input.orgId,
    connectionId: input.connectionId,
    reserveContentLaunch: true,
    patch: {
      lastContentCommitSha: input.commitSha,
      lastContentLaunchToken: input.launchToken ?? null,
    },
  })
  const workflowInput = {
    orgId: input.orgId,
    connectionId: input.connectionId,
    contentSyncGeneration: reserved.contentSyncGeneration,
    commitSha: input.commitSha,
    ...(input.launchToken ? { launchToken: input.launchToken } : {}),
    ...(reserved.repositoryId ? { repositoryId: reserved.repositoryId } : {}),
    ...(reserved.branch ? { branch: reserved.branch } : {}),
  }
  const baseKey = githubPrMirrorContentIdempotencyKey({
    connectionId: input.connectionId,
    commitSha: input.commitSha,
    launchToken: input.launchToken,
  })
  let idempotencyKey = baseKey
  const failedRunIds = new Set<string>()
  for (;;) {
    const handle = await runWorkflowWithWorkerWake(
      githubSyncContent.spec,
      workflowInput,
      { idempotencyKey },
    )
    const { id, status } = handle.workflowRun
    if (status !== "failed" && status !== "canceled") {
      return { id, status }
    }
    if (failedRunIds.has(id)) {
      throw new Error(`GitHub PR mirror content remained ${status}: ${id}`)
    }
    failedRunIds.add(id)
    idempotencyKey = `${baseKey}:retry:${id}`
  }
}

export const githubSyncContent = defineWorkflow(
  {
    name: "github-sync-content",
    schema: GithubSyncContentInputSchema,
  },
  async ({ input, step, run }) =>
    withLogger(
      createLogger({
        workflow: "github-sync-content",
        orgId: input.orgId,
        connectionId: input.connectionId,
      }),
      async () => {
        const env = parseEnv(process.env as Record<string, string | undefined>)
        const claimed = await step.run(
          { name: "activate-github-pr-content" },
          () =>
            patchGithubPrMirror({
              orgId: input.orgId,
              connectionId: input.connectionId,
              workflowRunId: run.id,
              claimContentRun: true,
              expectedContentSyncGeneration: input.contentSyncGeneration,
              expectedRepositoryId: input.repositoryId,
              expectedBranch: input.branch,
              patch: {
                setupPhase: "initial_sync",
                pendingConfigPullUrl: null,
                enabled: true,
              },
            }),
        )
        if (!claimed.applied) {
          return {
            written: 0,
            failedRepositories: [] as string[],
            status: "superseded" as const,
          }
        }
        const generation = claimed.contentSyncGeneration
        const binding = await step.run(
          { name: "load-github-pr-mirror" },
          async () => {
            const current = await getGithubPrMirrorBinding(
              input.orgId,
              input.connectionId,
            )
            if (!current?.enabled) {
              throw new Error("GitHub pull request mirror is not bound")
            }
            if (
              (input.repositoryId != null &&
                current.repositoryId !== input.repositoryId) ||
              (input.branch != null && current.branch !== input.branch) ||
              current.contentSyncGeneration !== generation
            ) {
              return { superseded: true as const }
            }
            return current
          },
        )
        if ("superseded" in binding) {
          return {
            written: 0,
            failedRepositories: [] as string[],
            status: "superseded" as const,
          }
        }

        const stillOwns = async () => {
          const current = await getGithubPrMirrorBinding(
            input.orgId,
            input.connectionId,
          )
          return (
            current?.contentSyncGeneration === generation &&
            current.repositoryId === binding.repositoryId &&
            current.branch === binding.branch
          )
        }

        try {
          if (!(await stillOwns())) {
            return {
              written: 0,
              failedRepositories: [] as string[],
              status: "superseded" as const,
            }
          }
          const context = await step.run(
            { name: "capture-github-pr-mirror" },
            async () => {
              if (!(await stillOwns())) {
                return { superseded: true as const }
              }
              const captured = await captureConnectorMirrorTarget({
                repositoryGitUrl: binding.gitUrl,
                orgId: input.orgId,
                env,
                mirror: {
                  provider: "github",
                  connectionId: input.connectionId,
                  repositoryId: binding.repositoryId,
                },
              })
              const config = parseGithubPrConfigYamlContent(captured.config)
              if (!config) throw new Error("github/config.yaml was not found")
              return { captured, config }
            },
          )
          if ("superseded" in context) {
            return {
              written: 0,
              failedRepositories: [] as string[],
              status: "superseded" as const,
            }
          }
          let revision = context.captured.revision
          let written = 0
          let superseded = false
          const failedRepositories: string[] = []
          for (const repository of context.config.repositories) {
            if (!(await stillOwns())) {
              superseded = true
              break
            }
            const repoKey = githubPrMirrorRepoKey(repository)
            try {
              const listed = await step.run(
                { name: `list-github-pull-requests:${repoKey}` },
                () =>
                  listGithubPullRequestNumbersForConfig({
                    orgId: input.orgId,
                    env,
                    binding,
                    config: context.config,
                    repository,
                  }),
              )
              for (
                let batchIndex = 0;
                batchIndex * GITHUB_PR_MIRROR_COMMIT_BATCH <
                listed.numbers.length;
                batchIndex++
              ) {
                const numbers = listed.numbers.slice(
                  batchIndex * GITHUB_PR_MIRROR_COMMIT_BATCH,
                  (batchIndex + 1) * GITHUB_PR_MIRROR_COMMIT_BATCH,
                )
                const mirrored = await step.run(
                  {
                    name: `mirror-github-pull-requests:${repoKey}:${batchIndex}`,
                  },
                  () =>
                    captureGithubPullRequestsForConfig({
                      orgId: input.orgId,
                      env,
                      binding,
                      config: context.config,
                      repository,
                      numbers,
                    }),
                )
                if (mirrored.files.length === 0) continue
                if (!(await stillOwns())) {
                  superseded = true
                  break
                }
                const result = await step.runWorkflow(
                  workspaceConnectorMirror.spec,
                  {
                    orgId: input.orgId,
                    workspaceId: context.captured.workspaceId,
                    revision,
                    mirror: {
                      ...context.captured.mirror,
                      contentSyncGeneration: generation,
                    },
                    jobId: `wjob_${run.id}_mirror_${repoKey}_${batchIndex}`,
                    files: mirrored.files,
                    deletePaths: [],
                  },
                  { name: `commit-github-pr-mirror:${repoKey}:${batchIndex}` },
                )
                revision = publishedRevision(revision, result)
                written += mirrored.files.length
              }
              if (superseded) break
            } catch (error) {
              if (isWorkflowControlSignal(error)) throw error
              failedRepositories.push(repository)
              getLogger().error(
                error instanceof Error ? error : new Error(String(error)),
                {
                  step: "github-sync-content.repository",
                  connectionId: input.connectionId,
                  repository,
                },
              )
            }
          }
          if (written > 0) {
            await step.run({ name: "ingest-github-pull-requests" }, () =>
              runRepositoryIngestionWorkflow(
                {
                  orgId: input.orgId,
                  repositoryId: binding.repositoryId,
                  targetBranch: binding.branch,
                  indexingReason: "Mirroring GitHub pull requests",
                },
                {
                  error: (error) =>
                    getLogger().error(error, {
                      step: "github-sync-content.ingestion",
                      connectionId: input.connectionId,
                    }),
                },
              ),
            )
          }
          if (superseded) {
            return {
              written,
              failedRepositories,
              status: "superseded" as const,
            }
          }
          if (failedRepositories.length > 0) {
            const everyRepositoryFailed =
              failedRepositories.length === context.config.repositories.length
            throw new Error(
              everyRepositoryFailed
                ? `GitHub pull request backfill failed for every repository: ${failedRepositories.join(", ")}`
                : `GitHub pull request backfill failed for repositories: ${failedRepositories.join(", ")}`,
            )
          }
          const live = await patchGithubPrMirror({
            orgId: input.orgId,
            connectionId: input.connectionId,
            expectedContentSyncGeneration: generation,
            expectedRepositoryId: binding.repositoryId,
            expectedBranch: binding.branch,
            patch: { setupPhase: "live" },
          })
          if (!live.applied) {
            return {
              written,
              failedRepositories,
              status: "superseded" as const,
            }
          }
          return {
            written,
            failedRepositories,
          }
        } catch (error) {
          if (isWorkflowControlSignal(error)) throw error
          await patchGithubPrMirror({
            orgId: input.orgId,
            connectionId: input.connectionId,
            expectedContentSyncGeneration: generation,
            expectedRepositoryId: binding.repositoryId,
            expectedBranch: binding.branch,
            patch: { setupPhase: "sync_failed" },
          })
          throw error
        }
      },
    ),
)
