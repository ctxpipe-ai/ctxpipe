import { parseEnv } from "../../../config/env.js"
import { withOrgDbContext } from "../../../db/client.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import {
  claimPagerdutyBindingInitialSync,
  getPagerdutyConnectionByConnectionId,
  listPagerdutyBindingsWithRepoByRepositoryId,
  resetPagerdutyConnectorAfterMissingConfig,
  transitionPagerdutyBindingState,
} from "../../../models/pagerduty-connector.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { pagerdutySyncContent } from "../../../openworkflow/workflows/pagerduty-sync-content.js"
import {
  githubCommitsMissingPathEntirely,
  githubPushTouchesPath,
} from "../../../services/confluence/github-push-config-sync.js"
import { compareCommitsTouchesPath } from "../../../services/github/installation-write-client.js"
import {
  loadPagerdutyScopeFromRepo,
  PAGERDUTY_CONFIG_PATH,
} from "../../../services/pagerduty/config-from-repo.js"

const GIT_EMPTY_TREE_SHA = "0000000000000000000000000000000000000000"

type GithubWebhookLog = { error: (error: Error) => void }

export async function maybeActivatePagerdutySyncOnConfigPush(input: {
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
  log: GithubWebhookLog
}): Promise<void> {
  const branchPrefix = "refs/heads/"
  if (!input.ref.startsWith(branchPrefix)) return
  const pushedBranch = input.ref.slice(branchPrefix.length)
  if (!pushedBranch) return

  const touchedByCommitLists = githubPushTouchesPath({
    commits: input.commits,
    path: PAGERDUTY_CONFIG_PATH,
  })
  const canCompare =
    Boolean(input.before && input.after) &&
    input.before !== GIT_EMPTY_TREE_SHA &&
    input.after !== GIT_EMPTY_TREE_SHA
  const needsCompareFallback =
    githubCommitsMissingPathEntirely({
      commits: input.commits,
      path: PAGERDUTY_CONFIG_PATH,
    }) && canCompare
  if (!touchedByCommitLists && !needsCompareFallback) return

  const env = parseEnv(process.env as Record<string, string | undefined>)
  const compareCache = new Map<string, Promise<boolean>>()
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
      let comparison = compareCache.get(repository.id)
      if (!comparison) {
        comparison = compareCommitsTouchesPath({
          orgId: installation.orgId,
          env,
          repositoryName: repository.name,
          githubConnectionId: repository.githubConnectionId,
          baseSha: input.before,
          headSha: input.after,
          path: PAGERDUTY_CONFIG_PATH,
        })
        compareCache.set(repository.id, comparison)
      }
      configTouched = await comparison
    }
    if (!configTouched) continue

    const targets = await listPagerdutyBindingsWithRepoByRepositoryId(
      repository.id,
    )
    for (const target of targets) {
      if (target.branch !== pushedBranch) continue
      const githubConnectionId =
        target.githubConnectionId ?? repository.githubConnectionId
      const config = await loadPagerdutyScopeFromRepo({
        orgId: target.orgId,
        env,
        repositoryName: target.repositoryName,
        githubConnectionId,
        branch: target.branch,
      })
      if (!config) {
        await resetPagerdutyConnectorAfterMissingConfig({
          orgId: target.orgId,
          connectionId: target.connectionId,
        })
        continue
      }

      const connection = await withOrgDbContext(target.orgId, () =>
        getPagerdutyConnectionByConnectionId(
          target.orgId,
          target.connectionId,
          env,
        ),
      )
      if (!connection || connection.accountId !== config.accountId) {
        input.log.error(
          new Error(
            "pagerduty/config.yaml account does not match the PagerDuty connection",
          ),
        )
        await resetPagerdutyConnectorAfterMissingConfig({
          orgId: target.orgId,
          connectionId: target.connectionId,
        })
        continue
      }

      if (
        !(await claimPagerdutyBindingInitialSync({
          connectionId: target.connectionId,
          repositoryId: target.repositoryId,
          branch: target.branch,
        }))
      ) {
        continue
      }
      try {
        await runWorkflowWithWorkerWake(pagerdutySyncContent.spec, {
          orgId: target.orgId,
          connectionId: target.connectionId,
        })
      } catch (error) {
        await transitionPagerdutyBindingState({
          connectionId: target.connectionId,
          expectedSetupPhase: "initial_sync",
          expectedPendingConfigPrCreating: false,
          repositoryId: target.repositoryId,
          branch: target.branch,
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          setupPhase: "awaiting_merge",
        })
        input.log.error(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    }
  }
}
