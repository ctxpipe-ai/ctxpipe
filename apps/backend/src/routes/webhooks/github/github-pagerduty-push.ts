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
import { connectorConfigPush } from "../../../services/confluence/github-push-config-sync.js"
import {
  compareCommitsTouchesPath,
  workspaceRootPathOfRepository,
} from "../../../services/github/installation-write-client.js"
import {
  loadPagerdutyScopeFromRepo,
  PAGERDUTY_CONFIG_PATH,
} from "../../../services/pagerduty/config-from-repo.js"

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

  const push = connectorConfigPush({
    commits: input.commits,
    before: input.before,
    after: input.after,
    path: PAGERDUTY_CONFIG_PATH,
  })
  if (!push.mayTouch) return

  const env = parseEnv(process.env as Record<string, string | undefined>)
  const compareCache = new Map<string, Promise<boolean>>()
  const installations = await listInstallationsByGithubInstallationId(
    input.installationId,
    input.githubConnectionId,
    env,
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

    const repositoryConnectionId = repository.githubConnectionId
    // The config file is relative to the root folder of the org's Workspace.
    const rootPath = await workspaceRootPathOfRepository({
      orgId: installation.orgId,
      repositoryName: repository.name,
    })
    const configTouched = await push.touches(rootPath, (path, base, head) => {
      const key = `${repository.id}:${path}`
      let comparison = compareCache.get(key)
      if (!comparison) {
        comparison = compareCommitsTouchesPath({
          orgId: installation.orgId,
          env,
          repositoryName: repository.name,
          githubConnectionId: repositoryConnectionId,
          baseSha: base,
          headSha: head,
          path,
        })
        compareCache.set(key, comparison)
      }
      return comparison
    })
    if (!configTouched) continue

    const targets = await listPagerdutyBindingsWithRepoByRepositoryId(
      installation.orgId,
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

      const connection = await getPagerdutyConnectionByConnectionId(
        target.orgId,
        target.connectionId,
        env,
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
          orgId: target.orgId,
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
          orgId: target.orgId,
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
