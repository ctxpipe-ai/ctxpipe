import type { Env } from "../../../config/env.js"
import { withOrgDbContext } from "../../../db/client.js"
import {
  bindGithubPrMirror,
  patchGithubPrMirror,
} from "../../../models/github-pr-mirror.js"
import { resolveGithubPrMirrorTarget } from "../../../models/github-pr-mirror-target.js"
import { listRepositoriesForGithubConnectionForOrg } from "../../../models/repositories.js"
import { getLogger } from "../../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { githubSyncContent } from "../../../openworkflow/workflows/github-sync-content.js"
import { loadGithubPrMirrorConfigFromRepo } from "./config-from-repo.js"
import { sourceRepositoriesForPrMirror } from "./source-scope.js"
import { commitGithubPrMirrorConfigYaml } from "./sync.js"

export type EnsureGithubPrMirrorResult = {
  status: "skipped_no_context" | "unchanged" | "started"
}

function sameRepositoryList(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((name, i) => name === right[i])
  )
}

export async function ensureGithubPrMirror(input: {
  orgId: string
  connectionId: string
  env: Env
  repositoryId?: string
  branch?: string
}): Promise<EnsureGithubPrMirrorResult> {
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
  const alreadyLive =
    binding.setupPhase === "live" || binding.setupPhase === "initial_sync"
  if (
    current &&
    sameRepositoryList(current.repositories, repositories) &&
    alreadyLive
  ) {
    return { status: "unchanged" }
  }

  await commitGithubPrMirrorConfigYaml({
    orgId: input.orgId,
    env: input.env,
    binding,
    repositories,
  })
  await withOrgDbContext(input.orgId, () =>
    patchGithubPrMirror({
      orgId: input.orgId,
      connectionId: input.connectionId,
      patch: {
        setupPhase: "initial_sync",
        pendingConfigPullUrl: null,
        enabled: true,
      },
    }),
  )
  await runWorkflowWithWorkerWake(githubSyncContent.spec, {
    orgId: input.orgId,
    connectionId: input.connectionId,
  })
  return { status: "started" }
}

export async function tryEnsureGithubPrMirror(input: {
  orgId: string
  connectionId: string
  env: Env
}): Promise<EnsureGithubPrMirrorResult | { status: "failed" }> {
  try {
    return await ensureGithubPrMirror(input)
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      { step: "github.pr-mirror.ensure" },
    )
    return { status: "failed" }
  }
}
