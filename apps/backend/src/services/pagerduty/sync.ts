import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { resolvePagerdutyOAuthAppCreds } from "../../lib/connection-config.js"
import type {
  PagerdutyBinding,
  PagerdutyConnection,
} from "../../models/pagerduty-connector.js"
import {
  getPagerdutyConnectionByConnectionId,
  recordPagerdutyOAuthRevocation,
  refreshPagerdutyConnectionTokensWithLock,
} from "../../models/pagerduty-connector.js"
import {
  connectorPathMatchesPreservation,
  createConnectorAssetBudget,
  createConnectorAssetBytePool,
} from "../connectors/assets.js"
import {
  type CommitFile,
  closePullRequest,
  createPullRequestWithFiles,
  getFileContent,
  parseGithubPullNumberFromUrl,
} from "../github/installation-write-client.js"
import {
  getPagerdutyIncident,
  isPagerdutyAuthorizationRevokedError,
  listPagerdutyIncidentIdsForService,
  refreshPagerdutyOAuthToken,
} from "./client.js"
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
      const expectedAccessToken = input.connection.accessToken
      if (expectedAccessToken) {
        await withOrgDbContext(input.orgId, () =>
          recordPagerdutyOAuthRevocation({
            orgId: input.orgId,
            connectionId: input.connection.id,
            env: input.env,
            expectedAccessToken,
          }),
        )
      }
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

export async function capturePagerdutyContent(input: {
  orgId: string
  env: Env
  connection: PagerdutyConnection
  config: ParsedPagerdutyRepoConfig
  existingPaths: string[]
}): Promise<{
  status: PagerdutySyncResult["status"]
  files: CommitFile[]
  deletePaths: string[]
  resourcesProcessed: number
  resourcesFailed: number
  errors: Array<{ externalId: string; message: string }>
}> {
  const accessToken = await resolveFreshAccessToken({
    orgId: input.orgId,
    env: input.env,
    connection: input.connection,
  })

  const filesToWrite: CommitFile[] = []
  const preservePathPrefixes: string[] = []
  const assetBytePool = createConnectorAssetBytePool()
  const errors: Array<{ externalId: string; message: string }> = []
  let resourcesProcessed = 0
  let resourcesFailed = 0

  for (const service of input.config.services) {
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
        if (!pagerdutyIncidentIsInScope(incident, input.config)) continue
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
            env: input.env,
            expectedAccessToken: accessToken,
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

  const managedRepoFiles = input.existingPaths.filter(
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

  return {
    status:
      resourcesFailed === 0
        ? "completed"
        : resourcesProcessed > 0
          ? "partial_failed"
          : "failed",
    files: filesToWrite,
    deletePaths,
    resourcesProcessed,
    resourcesFailed,
    errors,
  }
}

export type PagerdutyIncrementalCaptureResult = {
  status: "completed" | "failed"
  files: CommitFile[]
  deletePaths: string[]
  errors: Array<{ externalId: string; message: string }>
}

export async function capturePagerdutyIncrementalContent(input: {
  orgId: string
  env: Env
  connection: PagerdutyConnection
  config: ParsedPagerdutyRepoConfig
  existingPaths: string[]
  entity: PagerdutyEntityChange
}): Promise<PagerdutyIncrementalCaptureResult> {
  const accessToken = await resolveFreshAccessToken({
    orgId: input.orgId,
    env: input.env,
    connection: input.connection,
  })
  input.connection.accessToken = accessToken

  const managedPaths = input.existingPaths.filter(
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
          env: input.env,
          expectedAccessToken: accessToken,
        }),
      )
    }
    throw error
  }

  return {
    status: changes.failures.length > 0 ? "failed" : "completed",
    files: changes.files,
    deletePaths: changes.deletePaths,
    errors: changes.failures.map((failure) => ({
      externalId: failure.id,
      message: failure.message,
    })),
  }
}
