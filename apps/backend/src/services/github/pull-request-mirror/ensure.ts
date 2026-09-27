import type { Env } from "../../../config/env.js"
import { withOrgDbContext } from "../../../db/client.js"
import {
  bindGithubPrMirror,
  patchGithubPrMirror,
} from "../../../models/github-pr-mirror.js"
import { resolveGithubPrMirrorTarget } from "../../../models/github-pr-mirror-target.js"
import { listRepositoriesForGithubConnectionForOrg } from "../../../models/repositories.js"
import { getLogger } from "../../../observability/logger.js"
import { loadGithubPrMirrorConfigFromRepo } from "./config-from-repo.js"
import { sourceRepositoriesForPrMirror } from "./source-scope.js"
import { prepareGithubPrMirrorConfigYaml } from "./sync.js"

export type GithubPrMirrorEnsurePlan =
  | { status: "skipped_no_context" }
  | { status: "unchanged" }
  | { status: "retry_content"; commitSha: string; launchToken: string | null }
  | {
      status: "write_config"
      orgId: string
      connectionId: string
      contentSyncGeneration: number
      fallbackCommitSha: string
      mirrorInput: {
        orgId: string
        workspaceId: string
        revision: Awaited<
          ReturnType<typeof prepareGithubPrMirrorConfigYaml>
        >["captured"]["revision"]
        mirror: Awaited<
          ReturnType<typeof prepareGithubPrMirrorConfigYaml>
        >["captured"]["mirror"]
        jobId: string
        files: Awaited<
          ReturnType<typeof prepareGithubPrMirrorConfigYaml>
        >["files"]
        deletePaths: []
      }
    }

function sameRepositoryList(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((name, i) => name === right[i])
  )
}

export async function planGithubPrMirrorEnsure(input: {
  orgId: string
  connectionId: string
  env: Env
  repositoryId?: string
  branch?: string
}): Promise<GithubPrMirrorEnsurePlan> {
  const target = input.repositoryId
    ? {
        repositoryId: input.repositoryId,
        branch: input.branch ?? "main",
      }
    : await withOrgDbContext(input.orgId, () =>
        resolveGithubPrMirrorTarget({
          orgId: input.orgId,
          connectionId: input.connectionId,
        }),
      )
  if (!target) return { status: "skipped_no_context" }

  const binding = await withOrgDbContext(input.orgId, () =>
    bindGithubPrMirror({
      orgId: input.orgId,
      connectionId: input.connectionId,
      repositoryId: target.repositoryId,
      branch: target.branch,
    }),
  )

  const repositories = sourceRepositoriesForPrMirror(
    (
      await listRepositoriesForGithubConnectionForOrg(
        input.orgId,
        input.connectionId,
      )
    ).map((repository) => repository.name),
    binding.repositoryName,
  )

  const current = await loadGithubPrMirrorConfigFromRepo({
    orgId: input.orgId,
    env: input.env,
    repositoryName: binding.repositoryName,
    githubConnectionId: binding.githubConnectionId,
    branch: binding.branch,
  })
  // `initial_sync` is written by githubSyncContent after its handler starts,
  // so either phase proves the content handoff happened.
  const contentStarted =
    binding.setupPhase === "live" || binding.setupPhase === "initial_sync"
  if (
    current &&
    sameRepositoryList(current.repositories, repositories) &&
    contentStarted
  ) {
    return { status: "unchanged" }
  }
  if (
    current &&
    sameRepositoryList(current.repositories, repositories) &&
    binding.setupPhase === "sync_failed" &&
    binding.lastContentCommitSha
  ) {
    return {
      status: "retry_content",
      commitSha: binding.lastContentCommitSha,
      launchToken: binding.lastContentLaunchToken ?? null,
    }
  }

  const prepared = await prepareGithubPrMirrorConfigYaml({
    orgId: input.orgId,
    env: input.env,
    binding,
    repositories,
  })
  return {
    status: "write_config",
    orgId: input.orgId,
    connectionId: input.connectionId,
    contentSyncGeneration: binding.contentSyncGeneration,
    fallbackCommitSha: prepared.captured.revision.sha,
    mirrorInput: {
      orgId: input.orgId,
      workspaceId: prepared.captured.workspaceId,
      revision: prepared.captured.revision,
      mirror: prepared.captured.mirror,
      jobId: prepared.jobId,
      files: prepared.files,
      deletePaths: [],
    },
  }
}

export async function recordGithubPrMirrorEnsureFailure(input: {
  orgId: string
  connectionId: string
  expectedContentSyncGeneration: number
}): Promise<void> {
  await withOrgDbContext(input.orgId, () =>
    patchGithubPrMirror({
      orgId: input.orgId,
      connectionId: input.connectionId,
      expectedContentSyncGeneration: input.expectedContentSyncGeneration,
      patch: { setupPhase: "sync_failed" },
    }),
  )
}

export async function tryEnsureGithubPrMirror(input: {
  orgId: string
  connectionId: string
  env: Env
}): Promise<GithubPrMirrorEnsurePlan | { status: "failed" }> {
  try {
    return await planGithubPrMirrorEnsure(input)
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      { step: "github.pr-mirror.ensure" },
    )
    return { status: "failed" }
  }
}
