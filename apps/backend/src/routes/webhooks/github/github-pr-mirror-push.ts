import { parseEnv } from "../../../config/env.js"
import { withOrgDbContext } from "../../../db/client.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { listGithubPrMirrorBindingsForRepository } from "../../../models/github-pr-mirror.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import { getLogger } from "../../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { githubSyncContent } from "../../../openworkflow/workflows/github-sync-content.js"
import {
  githubCommitsMissingPathEntirely,
  githubPushTouchesPath,
} from "../../../services/confluence/github-push-config-sync.js"
import { compareCommitsTouchesPath } from "../../../services/github/installation-write-client.js"
import { GITHUB_PR_CONFIG_PATH } from "../../../services/github/pull-request-mirror/converter.js"

const GIT_EMPTY_TREE_SHA = "0000000000000000000000000000000000000000"

export async function maybeActivateGithubPrMirrorOnConfigPush(input: {
  installationId: number
  githubConnectionId?: string
  repoFullName: string
  ref: string
  commits?: Array<{
    added?: string[]
    modified?: string[]
    removed?: string[]
  }>
  before?: string
  after?: string
}): Promise<void> {
  const branchPrefix = "refs/heads/"
  if (!input.ref.startsWith(branchPrefix)) return
  const pushedBranch = input.ref.slice(branchPrefix.length)
  if (!pushedBranch) return

  const touchedByCommitLists = githubPushTouchesPath({
    commits: input.commits,
    path: GITHUB_PR_CONFIG_PATH,
  })
  const canCompare =
    Boolean(input.before && input.after) &&
    input.before !== GIT_EMPTY_TREE_SHA &&
    input.after !== GIT_EMPTY_TREE_SHA
  const needsCompareFallback =
    githubCommitsMissingPathEntirely({
      commits: input.commits,
      path: GITHUB_PR_CONFIG_PATH,
    }) && canCompare
  if (!touchedByCommitLists && !needsCompareFallback) return

  const env = parseEnv(process.env as Record<string, string | undefined>)
  const installations = (
    await listInstallationsByGithubInstallationId(input.installationId)
  ).filter(
    (installation) =>
      !input.githubConnectionId || installation.id === input.githubConnectionId,
  )

  for (const installation of installations) {
    const repository = await withOrgDbContext(installation.orgId, () =>
      findRepositoryByGithubInstallation(
        installation.orgId,
        input.repoFullName,
        installation.id,
      ),
    )
    if (!repository?.githubConnectionId) continue

    let configTouched = touchedByCommitLists
    if (!configTouched && needsCompareFallback && input.before && input.after) {
      configTouched = await compareCommitsTouchesPath({
        orgId: installation.orgId,
        env,
        repositoryName: repository.name,
        githubConnectionId: repository.githubConnectionId,
        baseSha: input.before,
        headSha: input.after,
        path: GITHUB_PR_CONFIG_PATH,
      })
    }
    if (!configTouched) continue

    const bindings = await listGithubPrMirrorBindingsForRepository(
      repository.id,
    )
    for (const binding of bindings) {
      if (binding.branch !== pushedBranch) continue
      if (binding.connectionId !== installation.id) continue
      try {
        await runWorkflowWithWorkerWake(githubSyncContent.spec, {
          orgId: binding.orgId,
          connectionId: binding.connectionId,
        })
      } catch (error) {
        getLogger().error(
          error instanceof Error ? error : new Error(String(error)),
          { step: "github.pr-mirror.config-push" },
        )
      }
    }
  }
}
