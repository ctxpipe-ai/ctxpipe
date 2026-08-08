import { parseEnv } from "../../../config/env.js"
import { withOrgDbContext } from "../../../db/client.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import {
  applyLinearRepoConfig,
  getLinearConnectionByConnectionId,
  listLinearSyncTargetsWithRepoByRepositoryId,
  markLinearSyncTargetInitialSync,
  resetLinearConnectorAfterMissingConfig,
} from "../../../models/linear-connector.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import {
  githubCommitsMissingPathEntirely,
  githubPushTouchesPath,
} from "../../../services/confluence/github-push-config-sync.js"
import { compareCommitsTouchesPath } from "../../../services/github/installation-write-client.js"
import {
  LINEAR_CONFIG_PATH,
  loadLinearScopeFromRepo,
} from "../../../services/linear/config-from-repo.js"

const GIT_EMPTY_TREE_SHA = "0000000000000000000000000000000000000000"

type GithubWebhookLog = { error: (error: Error) => void }

export async function maybeActivateLinearSyncOnConfigPush(input: {
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
    path: LINEAR_CONFIG_PATH,
  })
  const canCompare =
    Boolean(input.before && input.after) &&
    input.before !== GIT_EMPTY_TREE_SHA &&
    input.after !== GIT_EMPTY_TREE_SHA
  const needsCompareFallback =
    githubCommitsMissingPathEntirely({
      commits: input.commits,
      path: LINEAR_CONFIG_PATH,
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
          path: LINEAR_CONFIG_PATH,
        }).catch((error: unknown) => {
          input.log.error(
            error instanceof Error ? error : new Error(String(error)),
          )
          return false
        })
        compareCache.set(repository.id, comparison)
      }
      configTouched = await comparison
    }
    if (!configTouched) continue

    const targets = await listLinearSyncTargetsWithRepoByRepositoryId(
      repository.id,
    )
    for (const target of targets) {
      if (target.branch !== pushedBranch) continue
      const githubConnectionId =
        target.githubConnectionId ?? repository.githubConnectionId
      const config = await loadLinearScopeFromRepo({
        orgId: target.orgId,
        env,
        repositoryName: target.repositoryName,
        githubConnectionId,
        branch: target.branch,
      })
      if (!config) {
        await resetLinearConnectorAfterMissingConfig({
          orgId: target.orgId,
          connectionId: target.connectionId,
        })
        continue
      }

      const connection = await withOrgDbContext(target.orgId, () =>
        getLinearConnectionByConnectionId(
          target.orgId,
          target.connectionId,
          env,
        ),
      )
      if (!connection || connection.workspaceId !== config.workspaceId) {
        input.log.error(
          new Error(
            "linear/config.yaml workspace does not match the Linear connection",
          ),
        )
        await resetLinearConnectorAfterMissingConfig({
          orgId: target.orgId,
          connectionId: target.connectionId,
        })
        continue
      }

      await applyLinearRepoConfig({
        connectionId: target.connectionId,
        config,
      })
      await markLinearSyncTargetInitialSync(target.connectionId)
    }
  }
}
