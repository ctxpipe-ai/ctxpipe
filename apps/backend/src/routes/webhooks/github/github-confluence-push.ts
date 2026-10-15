import type { Env } from "../../../config/env.js"
import { withOrgDbContext } from "../../../db/client.js"
import { listConfluenceSyncTargetsWithRepoByRepositoryId } from "../../../models/confluence-sync-target.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import {
  enqueueConfluenceFullSyncAfterConfigPush,
  loadScopeForGithubPush,
} from "../../../openworkflow/enqueue-confluence-push-sync.js"
import { connectorConfigPush } from "../../../services/confluence/github-push-config-sync.js"
import {
  compareCommitsTouchesPath,
  workspaceRootPathOfRepository,
} from "../../../services/github/installation-write-client.js"

const CONFLUENCE_CONFIG_PATH = "confluence/config.yaml"

type GithubWebhookLog = { error: (e: Error) => void }

export async function maybeEnqueueConfluenceSyncOnConfigPush(input: {
  installationId: number
  repoFullName: string
  /** refs/heads/main */
  ref: string
  repository: {
    full_name: string
    default_branch?: string | null
  }
  commits?: Array<{
    added?: string[]
    modified?: string[]
    removed?: string[]
  }>
  /** Push payload SHAs — used when `commits[]` omits file paths */
  before?: string
  after?: string
  env: Env
  log: GithubWebhookLog
  githubConnectionId?: string
}): Promise<void> {
  const defaultBranch = input.repository.default_branch
  if (!defaultBranch) return
  if (input.ref !== `refs/heads/${defaultBranch}`) return

  const push = connectorConfigPush({
    commits: input.commits,
    before: input.before,
    after: input.after,
    path: CONFLUENCE_CONFIG_PATH,
  })
  if (!push.mayTouch) return

  const compareConfigPathCache = new Map<string, Promise<boolean>>()

  const installationRows = await listInstallationsByGithubInstallationId(
    input.installationId,
    input.githubConnectionId,
    input.env,
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

    // The config file is relative to the root folder of the org's Workspace.
    const rootPath = await workspaceRootPathOfRepository({
      orgId: installationRow.orgId,
      repositoryName: repositoryRow.name,
    })
    const resolveConfigPathTouchedForRepo = () =>
      push.touches(rootPath, (path, base, head) => {
        const key = `${repositoryRow.id}:${path}`
        const cached = compareConfigPathCache.get(key)
        if (cached) return cached
        const promise = compareCommitsTouchesPath({
          orgId: installationRow.orgId,
          env: input.env,
          repositoryName: repositoryRow.name,
          githubConnectionId: repositoryGithubConnectionId,
          baseSha: base,
          headSha: head,
          path,
        }).catch((err: unknown) => {
          input.log.error(err instanceof Error ? err : new Error(String(err)))
          return false
        })
        compareConfigPathCache.set(key, promise)
        return promise
      })

    const configPathTouched = await resolveConfigPathTouchedForRepo()
    if (!configPathTouched) continue

    const targets = await listConfluenceSyncTargetsWithRepoByRepositoryId(
      installationRow.orgId,
      repositoryRow.id,
    )

    for (const target of targets) {
      if (target.branch !== defaultBranch) continue
      const ghConn = target.githubConnectionId ?? repositoryGithubConnectionId
      if (!ghConn) continue

      const scope = await loadScopeForGithubPush({
        orgId: target.orgId,
        repositoryName: target.repositoryName,
        githubConnectionId: ghConn,
        branch: target.branch,
      })
      if (!scope) continue

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
