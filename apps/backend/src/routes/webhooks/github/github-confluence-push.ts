import { withOrgDbContext } from "../../../db/client.js"
import { listConfluenceSyncTargetsWithRepoByRepositoryId } from "../../../models/confluence-sync-target.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import {
  enqueueConfluenceFullSyncAfterConfigPush,
  loadScopeForGithubPush,
} from "../../../openworkflow/enqueue-confluence-push-sync.js"
import { githubPushTouchesPath } from "../../../services/confluence/github-push-config-sync.js"

type GithubWebhookLog = { error: (e: Error) => void }

export async function maybeEnqueueConfluenceSyncOnConfigPush(input: {
  installationId: number
  repoFullName: string
  /** refs/heads/main */
  ref: string
  repository: {
    full_name: string
    default_branch: string | null | undefined
  }
  commits?: Array<{
    added?: string[]
    modified?: string[]
    removed?: string[]
  }>
  log: GithubWebhookLog
}): Promise<void> {
  const defaultBranch = input.repository.default_branch
  if (!defaultBranch) return
  if (input.ref !== `refs/heads/${defaultBranch}`) return

  if (
    !githubPushTouchesPath({
      commits: input.commits,
      path: "confluence/config.yaml",
    })
  ) {
    return
  }

  const installationRows = await listInstallationsByGithubInstallationId(
    input.installationId,
  )

  for (const installationRow of installationRows) {
    const repository = await withOrgDbContext(installationRow.orgId, () =>
      findRepositoryByGithubInstallation(
        installationRow.orgId,
        input.repoFullName,
        installationRow.id,
      ),
    )
    if (!repository?.githubConnectionId) continue

    const targets = await listConfluenceSyncTargetsWithRepoByRepositoryId(
      repository.id,
    )

    for (const target of targets) {
      if (target.branch !== defaultBranch) continue
      const ghConn = target.githubConnectionId ?? repository.githubConnectionId
      if (!ghConn) continue

      const scope = await loadScopeForGithubPush({
        orgId: target.orgId,
        repositoryName: target.repositoryName,
        githubConnectionId: ghConn,
        branch: target.branch,
      })
      if (!scope?.spaces?.length) continue

      await enqueueConfluenceFullSyncAfterConfigPush({
        orgId: target.orgId,
        connectionId: target.connectionId,
        repositoryName: target.repositoryName,
        githubConnectionId: ghConn,
        branch: target.branch,
        scopeFromRepo: scope,
        log: input.log,
      })
    }
  }
}
