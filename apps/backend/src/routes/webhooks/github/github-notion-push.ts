import { parseEnv } from "../../../config/env.js"
import { withOrgDbContext } from "../../../db/client.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import {
  listNotionBindingsWithRepoByRepositoryId,
  resetNotionConnectorAfterMissingConfig,
} from "../../../models/notion-connector.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import {
  enqueueNotionFullSyncAfterConfigPush,
  loadNotionScopeForGithubPush,
} from "../../../openworkflow/enqueue-notion-push-sync.js"
import {
  githubCommitsMissingPathEntirely,
  githubPushTouchesPath,
} from "../../../services/confluence/github-push-config-sync.js"
import { compareCommitsTouchesPath } from "../../../services/github/installation-write-client.js"
import { NOTION_CONFIG_PATH } from "../../../services/notion/config-from-repo.js"

const GIT_EMPTY_TREE_SHA = "0000000000000000000000000000000000000000"

type GithubWebhookLog = { error: (e: Error) => void }

export async function maybeEnqueueNotionSyncOnConfigPush(input: {
  installationId: number
  repoFullName: string
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
  before?: string
  after?: string
  log: GithubWebhookLog
}): Promise<void> {
  const defaultBranch = input.repository.default_branch
  if (!defaultBranch) return
  if (input.ref !== `refs/heads/${defaultBranch}`) return

  const touchedByCommitLists = githubPushTouchesPath({
    commits: input.commits,
    path: NOTION_CONFIG_PATH,
  })
  const before = input.before
  const after = input.after
  const canCompare =
    Boolean(before && after) &&
    before !== GIT_EMPTY_TREE_SHA &&
    after !== GIT_EMPTY_TREE_SHA
  const needsCompareFallback =
    githubCommitsMissingPathEntirely({
      commits: input.commits,
      path: NOTION_CONFIG_PATH,
    }) && canCompare

  if (!touchedByCommitLists && !needsCompareFallback) return

  const env = parseEnv(process.env as Record<string, string | undefined>)
  const compareConfigPathCache = new Map<string, Promise<boolean>>()
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
    const repositoryRow = repository
    const repositoryGithubConnectionId = repository.githubConnectionId

    async function resolveConfigPathTouchedForRepo(): Promise<boolean> {
      if (touchedByCommitLists) return true
      if (!needsCompareFallback || !before || !after) return false
      const cached = compareConfigPathCache.get(repositoryRow.id)
      if (cached) return cached
      const promise = compareCommitsTouchesPath({
        orgId: installationRow.orgId,
        env,
        repositoryName: repositoryRow.name,
        githubConnectionId: repositoryGithubConnectionId,
        baseSha: before,
        headSha: after,
        path: NOTION_CONFIG_PATH,
      }).catch((err: unknown) => {
        input.log.error(err instanceof Error ? err : new Error(String(err)))
        return false
      })
      compareConfigPathCache.set(repositoryRow.id, promise)
      return promise
    }

    if (!(await resolveConfigPathTouchedForRepo())) continue

    const bindings = await listNotionBindingsWithRepoByRepositoryId(
      repositoryRow.id,
    )
    for (const binding of bindings) {
      if (binding.branch !== defaultBranch) continue
      const ghConn = binding.githubConnectionId ?? repositoryGithubConnectionId
      if (!ghConn) continue

      const scope = await loadNotionScopeForGithubPush({
        orgId: binding.orgId,
        repositoryName: binding.repositoryName,
        githubConnectionId: ghConn,
        branch: binding.branch,
      })
      if (!scope) {
        await resetNotionConnectorAfterMissingConfig({
          orgId: binding.orgId,
          connectionId: binding.connectionId,
        })
        continue
      }

      await enqueueNotionFullSyncAfterConfigPush({
        orgId: binding.orgId,
        connectionId: binding.connectionId,
        repositoryId: binding.repositoryId,
        branch: binding.branch,
        scopeFromRepo: scope,
      })
    }
  }
}
