import { parseEnv } from "../../../config/env.js"
import { withOrgDbContext } from "../../../db/client.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import {
  getLinearConnectionByConnectionId,
  listLinearBindingsWithRepoByRepositoryId,
  resetLinearConnectorAfterMissingConfig,
} from "../../../models/linear-connector.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import {
  connectorConfigKey,
  enqueueConnectorContentSync,
} from "../../../openworkflow/enqueue-connector-content-sync.js"
import { connectorConfigPush } from "../../../services/confluence/github-push-config-sync.js"
import {
  compareCommitsTouchesPath,
  workspaceRootPathOfRepository,
} from "../../../services/github/installation-write-client.js"
import {
  LINEAR_CONFIG_PATH,
  loadLinearScopeFromRepo,
} from "../../../services/linear/config-from-repo.js"
import { linearLegacySyncRetired } from "../../../services/linear/legacy-retired.js"

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

  const push = connectorConfigPush({
    commits: input.commits,
    before: input.before,
    after: input.after,
    path: LINEAR_CONFIG_PATH,
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

    const targets = await listLinearBindingsWithRepoByRepositoryId(
      installation.orgId,
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

      // ADR-050: a Workspace source that writes into this repository owns
      // the Linear files now; the legacy full sync would delete them.
      if (
        await linearLegacySyncRetired({
          orgId: target.orgId,
          connectionId: target.connectionId,
          syncRepositoryGitUrl: repository.gitUrl,
        })
      )
        continue

      try {
        await enqueueConnectorContentSync({
          orgId: target.orgId,
          connectionId: target.connectionId,
          provider: "linear",
          repositoryId: target.repositoryId,
          branch: target.branch,
          configKey: connectorConfigKey(config),
        })
      } catch (error) {
        input.log.error(
          error instanceof Error ? error : new Error(String(error)),
        )
        throw error
      }
    }
  }
}
