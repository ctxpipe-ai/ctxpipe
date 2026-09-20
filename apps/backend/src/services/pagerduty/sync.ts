import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import { resolvePagerdutyOAuthAppCreds } from "../../lib/connection-config.js"
import type {
  PagerdutyBinding,
  PagerdutyBindingWithRepo,
  PagerdutyConnection,
} from "../../models/pagerduty-connector.js"
import {
  getPagerdutyConnectionByConnectionId,
  recordPagerdutyOAuthRevocation,
  refreshPagerdutyConnectionTokensWithLock,
} from "../../models/pagerduty-connector.js"
import { repositories } from "../../db/schema/repositories.js"
import {
  connectorCommitFileUnchanged,
  connectorPathMatchesPreservation,
  createConnectorAssetBudget,
  createConnectorAssetBytePool,
} from "../connectors/assets.js"
import {
  type CommitFile,
  closePullRequest,
  commitFiles,
  createPullRequestWithFiles,
  getFileContent,
  listFilesInTree,
  parseGithubPullNumberFromUrl,
} from "../github/installation-write-client.js"
import {
  getPagerdutyIncident,
  isPagerdutyAuthorizationRevokedError,
  listPagerdutyIncidentIdsForService,
  refreshPagerdutyOAuthToken,
} from "./client.js"
import { loadPagerdutyScopeFromRepo } from "./config-from-repo.js"
import type {
  PagerdutyConfigService,
  ParsedPagerdutyRepoConfig,
} from "./config-yaml.js"
import {
  getPagerdutyConfigPullRequestPayload,
  hasPagerdutyConfigYamlChanged,
  renderPagerdutyConfigYaml,
} from "./config-yaml.js"
import { PAGERDUTY_CONFIG_PATH, PAGERDUTY_MANAGED_ROOT } from "./converter.js"
import {
  buildPagerdutyIncrementalChanges,
  type PagerdutyEntityChange,
  pagerdutyIncidentIsInScope,
} from "./incremental.js"
import { capturePagerdutyIncidentAssets } from "./sync-assets.js"

export type PagerdutySyncResult = {
  status: "completed" | "partial_failed" | "failed"
  resourcesProcessed: number
  resourcesFailed: number
  commitSha?: string
  pullUrl?: string
  errors: Array<{ externalId: string; message: string }>
}

function createPagerdutyTokenRefreshHandler(input: {
  orgId: string
  connectionId: string
  env: Env
}) {
  return (expectedRefreshToken: string, expectedAccessToken: string) =>
    withOrgDbContext(input.orgId, () =>
      refreshPagerdutyConnectionTokensWithLock({
        ...input,
        expectedRefreshToken,
        expectedAccessToken,
        refresh: async (refreshToken) => {
          const connection = await getPagerdutyConnectionByConnectionId(
            input.orgId,
            input.connectionId,
            input.env,
          )
          const creds = resolvePagerdutyOAuthAppCreds(connection, input.env)
          if (!creds) {
            throw new Error("PagerDuty OAuth is not configured")
          }
          try {
            const refreshed = await refreshPagerdutyOAuthToken({
              env: input.env,
              creds,
              refreshToken,
            })
            return {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
            }
          } catch (error) {
            if (isPagerdutyAuthorizationRevokedError(error)) {
              await recordPagerdutyOAuthRevocation({
                orgId: input.orgId,
                connectionId: input.connectionId,
              })
            }
            throw error
          }
        },
      }),
    )
}

async function resolveFreshAccessToken(input: {
  orgId: string
  env: Env
  connection: PagerdutyConnection
}): Promise<string> {
  const expiresAt = input.connection.accessTokenExpiresAt
  if (
    input.connection.accessToken &&
    expiresAt &&
    Date.parse(expiresAt) - 60_000 > Date.now()
  ) {
    return input.connection.accessToken
  }
  if (!input.connection.refreshToken || !input.connection.accessToken) {
    if (!input.connection.accessToken) {
      throw new Error("PagerDuty connection has no access token")
    }
    return input.connection.accessToken
  }
  try {
    const refresh = createPagerdutyTokenRefreshHandler({
      orgId: input.orgId,
      connectionId: input.connection.id,
      env: input.env,
    })
    const tokens = await refresh(
      input.connection.refreshToken,
      input.connection.accessToken,
    )
    input.connection.accessToken = tokens.accessToken
    input.connection.refreshToken = tokens.refreshToken
    input.connection.accessTokenExpiresAt = tokens.accessTokenExpiresAt
    return tokens.accessToken
  } catch (error) {
    if (isPagerdutyAuthorizationRevokedError(error)) {
      await withOrgDbContext(input.orgId, () =>
        recordPagerdutyOAuthRevocation({
          orgId: input.orgId,
          connectionId: input.connection.id,
        }),
      )
    }
    throw error
  }
}

async function resolveRepoContextForBinding(
  orgId: string,
  binding: PagerdutyBinding,
): Promise<{ repositoryName: string; githubConnectionId: string }> {
  return withOrgDbContext(orgId, async () => {
    const db = getOrgDb()
    const [row] = await db
      .select({
        name: repositories.name,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.id, binding.repositoryId),
          eq(repositories.orgId, orgId),
        ),
      )
      .limit(1)
    if (!row?.name) {
      throw new Error("PagerDuty binding repository not found for organization")
    }
    if (!row.githubConnectionId) {
      throw new Error(
        "PagerDuty binding repository has no GitHub connection; link the repository to a GitHub installation first",
      )
    }
    return {
      repositoryName: row.name,
      githubConnectionId: row.githubConnectionId,
    }
  })
}

export function getPagerdutyDeletePaths(input: {
  managedRepoPaths: string[]
  desiredPaths: Set<string>
  resourcesFailed: number
  preservePathPrefixes?: readonly string[]
}): string[] {
  if (input.resourcesFailed > 0) return []
  return input.managedRepoPaths.filter(
    (path) =>
      !input.desiredPaths.has(path) &&
      !(input.preservePathPrefixes ?? []).some((prefix) =>
        connectorPathMatchesPreservation(path, prefix),
      ),
  )
}

export async function syncPagerdutyConfigYaml(input: {
  orgId: string
  orgSlug: string
  env: Env
  connection: PagerdutyConnection
  binding: PagerdutyBinding
  services: PagerdutyConfigService[]
}): Promise<{ changed: boolean; pullUrl?: string }> {
  const { repositoryName, githubConnectionId } =
    await resolveRepoContextForBinding(input.orgId, input.binding)
  const current = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    githubConnectionId,
    branch: input.binding.branch,
    path: PAGERDUTY_CONFIG_PATH,
  })
  const next = renderPagerdutyConfigYaml({
    accountId: input.connection.accountId,
    accountName: input.connection.accountName,
    accountSubdomain: input.connection.accountSubdomain,
    region: input.connection.region,
    services: input.services,
  })
  const priorPullNumber = input.binding.pendingConfigPullUrl
    ? parseGithubPullNumberFromUrl(input.binding.pendingConfigPullUrl)
    : undefined
  if (priorPullNumber !== undefined) {
    await closePullRequest({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      githubConnectionId,
      pullNumber: priorPullNumber,
      comment:
        "Closing in favor of an updated PagerDuty sync configuration proposal.",
    })
  }
  if (!hasPagerdutyConfigYamlChanged({ current, next })) {
    return { changed: false }
  }
  const pr = getPagerdutyConfigPullRequestPayload({ orgSlug: input.orgSlug })
  const pull = await createPullRequestWithFiles({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    githubConnectionId,
    baseBranch: input.binding.branch,
    title: pr.title,
    body: pr.body,
    commitMessage: pr.commitMessage,
    files: [{ path: PAGERDUTY_CONFIG_PATH, content: next }],
    featureBranchPrefix: "ctxpipe/pagerduty-config",
  })
  return { changed: true, pullUrl: pull.pullUrl }
}

export async function syncPagerdutyContent(input: {
  orgId: string
  env: Env
  connection: PagerdutyConnection
  binding: PagerdutyBinding
  scopeFromRepo?: ParsedPagerdutyRepoConfig
}): Promise<PagerdutySyncResult> {
  if (input.binding.setupPhase === "awaiting_merge") {
    return {
      status: "completed",
      resourcesProcessed: 0,
      resourcesFailed: 0,
      errors: [],
    }
  }

  const { repositoryName, githubConnectionId } =
    await resolveRepoContextForBinding(input.orgId, input.binding)
  const repoScope =
    input.scopeFromRepo ??
    (await loadPagerdutyScopeFromRepo({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      githubConnectionId,
      branch: input.binding.branch,
    }))
  if (!repoScope) {
    throw new Error(
      "PagerDuty scope configuration is missing from the repository; expected pagerduty/config.yaml",
    )
  }

  const accessToken = await resolveFreshAccessToken({
    orgId: input.orgId,
    env: input.env,
    connection: input.connection,
  })

  const allRepoFiles = await listFilesInTree({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    branch: input.binding.branch,
    githubConnectionId,
  })
  const existingShaByPath = new Map(
    allRepoFiles.map((entry) => [entry.path, entry.sha]),
  )
  const filesToWrite: CommitFile[] = []
  const preservePathPrefixes: string[] = []
  const assetBytePool = createConnectorAssetBytePool()
  const errors: Array<{ externalId: string; message: string }> = []
  let resourcesProcessed = 0
  let resourcesFailed = 0

  for (const service of repoScope.services) {
    try {
      const incidentIds = await listPagerdutyIncidentIdsForService({
        accessToken,
        region: input.connection.region,
        serviceId: service.id,
      })
      for (const incidentId of incidentIds) {
        const incident = await getPagerdutyIncident({
          accessToken,
          region: input.connection.region,
          incidentId,
        })
        if (incident === "not_found") continue
        if (!pagerdutyIncidentIsInScope(incident, repoScope)) continue
        const captured = await capturePagerdutyIncidentAssets({
          incident,
          budget: createConnectorAssetBudget(),
          bytePool: assetBytePool,
        })
        filesToWrite.push(...captured.files)
        preservePathPrefixes.push(...captured.preservePathPrefixes)
        resourcesProcessed += 1
      }
    } catch (error) {
      if (isPagerdutyAuthorizationRevokedError(error)) {
        await withOrgDbContext(input.orgId, () =>
          recordPagerdutyOAuthRevocation({
            orgId: input.orgId,
            connectionId: input.connection.id,
          }),
        )
        throw error
      }
      resourcesFailed += 1
      errors.push({
        externalId: service.id,
        message:
          error instanceof Error
            ? error.message
            : "Unknown PagerDuty sync error",
      })
    }
  }

  const managedRepoFiles = allRepoFiles
    .map((entry) => entry.path)
    .filter(
      (path) =>
        path.startsWith(`${PAGERDUTY_MANAGED_ROOT}/`) &&
        path !== PAGERDUTY_CONFIG_PATH,
    )
  const desiredPaths = new Set(filesToWrite.map((file) => file.path))
  const deletePaths = getPagerdutyDeletePaths({
    managedRepoPaths: managedRepoFiles,
    desiredPaths,
    resourcesFailed,
    preservePathPrefixes,
  })

  const filesToCommit = filesToWrite.filter(
    (file) => !connectorCommitFileUnchanged(file, existingShaByPath),
  )

  let commitSha: string | undefined
  if (filesToCommit.length > 0 || deletePaths.length > 0) {
    const commit = await commitFiles({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch: input.binding.branch,
      githubConnectionId,
      message: "chore(pagerduty): sync content",
      files: filesToCommit,
      deletePaths,
    })
    commitSha = commit.commitSha
  }

  const status: PagerdutySyncResult["status"] =
    resourcesFailed === 0
      ? "completed"
      : resourcesProcessed > 0
        ? "partial_failed"
        : "failed"

  return {
    status,
    resourcesProcessed,
    resourcesFailed,
    commitSha,
    errors,
  }
}

export type PagerdutyIncrementalSyncResult = {
  status: "completed" | "failed"
  written: number
  deleted: number
  commitSha?: string
  errors: Array<{ externalId: string; message: string }>
}

export async function syncPagerdutyIncrementalContent(input: {
  orgId: string
  env: Env
  connection: PagerdutyConnection
  binding: PagerdutyBindingWithRepo
  config: ParsedPagerdutyRepoConfig
  entity: PagerdutyEntityChange
}): Promise<PagerdutyIncrementalSyncResult> {
  const { repositoryName, githubConnectionId, branch } = input.binding
  if (!githubConnectionId) {
    throw new Error(
      "PagerDuty binding repository has no GitHub connection; link the repository to a GitHub installation first",
    )
  }

  const accessToken = await resolveFreshAccessToken({
    orgId: input.orgId,
    env: input.env,
    connection: input.connection,
  })
  input.connection.accessToken = accessToken

  const allRepoFiles = await listFilesInTree({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    branch,
    githubConnectionId,
  })
  const existingShaByPath = new Map(
    allRepoFiles.map((entry) => [entry.path, entry.sha]),
  )
  const managedPaths = allRepoFiles
    .map((entry) => entry.path)
    .filter(
      (path) =>
        path.startsWith(`${PAGERDUTY_MANAGED_ROOT}/`) &&
        path !== PAGERDUTY_CONFIG_PATH,
    )

  let changes: Awaited<ReturnType<typeof buildPagerdutyIncrementalChanges>>
  try {
    changes = await buildPagerdutyIncrementalChanges({
      env: input.env,
      connection: input.connection,
      config: input.config,
      entity: input.entity,
      existingPaths: managedPaths,
      budget: createConnectorAssetBudget(),
    })
  } catch (error) {
    if (isPagerdutyAuthorizationRevokedError(error)) {
      await withOrgDbContext(input.orgId, () =>
        recordPagerdutyOAuthRevocation({
          orgId: input.orgId,
          connectionId: input.connection.id,
        }),
      )
    }
    throw error
  }

  const filesToCommit = changes.files.filter(
    (file) => !connectorCommitFileUnchanged(file, existingShaByPath),
  )

  let commitSha: string | undefined
  if (filesToCommit.length > 0 || changes.deletePaths.length > 0) {
    const commit = await commitFiles({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch,
      githubConnectionId,
      message: "chore(pagerduty): apply incremental updates",
      files: filesToCommit,
      deletePaths: changes.deletePaths,
    })
    commitSha = commit.commitSha
  }

  return {
    status: changes.failures.length > 0 ? "failed" : "completed",
    written: filesToCommit.length,
    deleted: changes.deletePaths.length,
    commitSha,
    errors: changes.failures.map((failure) => ({
      externalId: failure.id,
      message: failure.message,
    })),
  }
}
