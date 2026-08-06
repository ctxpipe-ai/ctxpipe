import { parseEnv } from "../../../config/env.js"
import { withOrgDbContext } from "../../../db/client.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import {
  listSlackSyncTargetsWithRepoByRepositoryId,
  resetSlackConnectorAfterMissingConfig,
} from "../../../models/slack-connector.js"
import { enqueueSlackFullSyncAfterConfigPush } from "../../../openworkflow/enqueue-slack-push-sync.js"
import {
  githubCommitsMissingPathEntirely,
  githubPushTouchesPath,
} from "../../../services/confluence/github-push-config-sync.js"
import { compareCommitsTouchesPath } from "../../../services/github/installation-write-client.js"
import {
  loadSlackScopeFromRepo,
  SLACK_CONFIG_PATH,
} from "../../../services/slack/config-from-repo.js"

const GIT_EMPTY_TREE_SHA = "0000000000000000000000000000000000000000"

type GithubWebhookLog = { error: (e: Error) => void }

export async function maybeEnqueueSlackSyncOnConfigPush(input: {
  installationId: number
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
  const branchRefPrefix = "refs/heads/"
  if (!input.ref.startsWith(branchRefPrefix)) return
  const pushedBranch = input.ref.slice(branchRefPrefix.length)
  if (!pushedBranch) return

  const touchedByCommitLists = githubPushTouchesPath({
    commits: input.commits,
    path: SLACK_CONFIG_PATH,
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
      path: SLACK_CONFIG_PATH,
    }) && canCompare

  if (!touchedByCommitLists && !needsCompareFallback) {
    return
  }

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
    const repoRow = repository
    if (typeof repoRow.githubConnectionId !== "string") continue
    const githubConnectionIdForCompare: string = repoRow.githubConnectionId

    async function resolveConfigPathTouchedForRepo(): Promise<boolean> {
      if (touchedByCommitLists) return true
      if (!needsCompareFallback || !before || !after) return false
      const cached = compareConfigPathCache.get(repoRow.id)
      if (cached) return cached
      const promise = compareCommitsTouchesPath({
        orgId: installationRow.orgId,
        env,
        repositoryName: repoRow.name,
        githubConnectionId: githubConnectionIdForCompare,
        baseSha: before,
        headSha: after,
        path: SLACK_CONFIG_PATH,
      }).catch((err: unknown) => {
        input.log.error(err instanceof Error ? err : new Error(String(err)))
        return false
      })
      compareConfigPathCache.set(repoRow.id, promise)
      return promise
    }

    const configPathTouched = await resolveConfigPathTouchedForRepo()
    if (!configPathTouched) continue

    const targets = await listSlackSyncTargetsWithRepoByRepositoryId(repoRow.id)

    for (const target of targets) {
      if (target.branch !== pushedBranch) continue
      const ghConn = target.githubConnectionId ?? githubConnectionIdForCompare
      if (!ghConn) continue

      const scope = await loadSlackScopeFromRepo({
        orgId: target.orgId,
        env,
        repositoryName: target.repositoryName,
        githubConnectionId: ghConn,
        branch: target.branch,
      })
      if (!scope) {
        await resetSlackConnectorAfterMissingConfig({
          orgId: target.orgId,
          connectionId: target.connectionId,
        })
        continue
      }

      await enqueueSlackFullSyncAfterConfigPush({
        orgId: target.orgId,
        connectionId: target.connectionId,
        log: input.log,
      })
    }
  }
}
