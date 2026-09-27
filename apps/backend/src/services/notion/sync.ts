import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import type {
  NotionBinding,
  NotionConnection,
} from "../../models/notion-connector.js"
import { refreshNotionConnectionTokensWithLock } from "../../models/notion-connector.js"
import { loadNotionStoredConfig } from "./connection-load.js"
import { resolveNotionOAuthApp } from "../../lib/notion-oauth.js"
import {
  connectorPathMatchesPreservation,
  createConnectorAssetBytePool,
  createConnectorEntityAssetBytePool,
  withConnectorAssetBytePoolRollback,
} from "../connectors/assets.js"
import {
  type CommitFile,
  closePullRequest,
  createPullRequestWithFiles,
  getFileContent,
  parseGithubPullNumberFromUrl,
} from "../github/installation-write-client.js"
import {
  buildNotionDatabaseMirrorFiles,
  buildNotionPageMirrorFiles,
  captureNotionEntityAssets,
  type NotionEntityAssetCapture,
  notionCommitFilesExcludingUnchanged,
  notionMatchingExistingAssetPaths,
} from "./assets.js"
import type {
  NotionBlock,
  NotionPage,
  NotionTokenRefreshHandler,
} from "./client.js"
import { queryNotionDatabase, refreshNotionOAuthToken } from "./client.js"
import { NOTION_CONFIG_PATH } from "./config-from-repo.js"
import type { ParsedNotionRepoConfig } from "./config-yaml.js"
import {
  getNotionConfigPullRequestPayload,
  hasNotionConfigYamlChanged,
  renderNotionConfigYaml,
} from "./config-yaml.js"
import {
  getManagedNotionRootPath,
  getNotionDatabaseIndexPath,
  getNotionDatabaseRowPath,
  getNotionPagePath,
  notionIdKey,
} from "./converter.js"
import {
  buildNotionIncrementalChanges,
  type NotionEntityChange,
} from "./incremental.js"
import {
  listBlocksDeep,
  listNotionPageTree,
  type NotionPageTreeEntry,
} from "./page-tree.js"

export { getNotionChildPageIds } from "./page-tree.js"

function createNotionTokenRefreshHandler(input: {
  orgId: string
  connectionId: string
  env: Env
}): NotionTokenRefreshHandler {
  return (expectedRefreshToken, expectedAccessToken) =>
    withOrgDbContext(input.orgId, () =>
      refreshNotionConnectionTokensWithLock({
        ...input,
        expectedRefreshToken,
        expectedAccessToken,
        refresh: async (refreshToken) => {
          const stored = await loadNotionStoredConfig(
            input.orgId,
            input.connectionId,
          )
          const app = resolveNotionOAuthApp(stored, input.env)
          if (!app) throw new Error("Notion OAuth is not configured")
          const refreshed = await refreshNotionOAuthToken({
            clientId: app.clientId,
            clientSecret: app.clientSecret,
            refreshToken,
          })
          return {
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token ?? refreshToken,
          }
        },
      }),
    )
}

export type NotionSyncResult = {
  status: "completed" | "partial_failed" | "failed"
  resourcesProcessed: number
  resourcesFailed: number
  files: Array<{ path: string; content: string }>
  deletePaths: string[]
  errors: Array<{ externalId: string; message: string }>
}

async function resolveRepoContextForBinding(
  orgId: string,
  binding: NotionBinding,
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
      throw new Error("Notion binding repository not found for organization")
    }
    if (!row.githubConnectionId) {
      throw new Error(
        "Notion binding repository has no GitHub connection; link the repository to a GitHub installation first",
      )
    }
    return {
      repositoryName: row.name,
      githubConnectionId: row.githubConnectionId,
    }
  })
}

export function getNotionDeletePaths(input: {
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

export async function syncNotionConfigYaml(input: {
  orgId: string
  orgSlug: string
  env: Env
  connectionId: string
  binding: NotionBinding
  resources: Array<{
    externalId: string
    type: "page" | "database"
    title: string
  }>
}): Promise<{ changed: boolean; pullUrl?: string }> {
  const { repositoryName, githubConnectionId } =
    await resolveRepoContextForBinding(input.orgId, input.binding)
  const current = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    githubConnectionId,
    branch: input.binding.branch,
    path: NOTION_CONFIG_PATH,
  })
  const next = renderNotionConfigYaml({
    resources: input.resources.map((resource) => ({
      externalId: resource.externalId,
      type: resource.type,
      title: resource.title,
    })),
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
        "Closing in favor of an updated Notion sync configuration proposal.",
    })
  }
  if (!hasNotionConfigYamlChanged({ current, next })) {
    return { changed: false }
  }
  const pr = getNotionConfigPullRequestPayload({ orgSlug: input.orgSlug })
  const pull = await createPullRequestWithFiles({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    githubConnectionId,
    baseBranch: input.binding.branch,
    title: pr.title,
    body: pr.body,
    commitMessage: pr.commitMessage,
    files: [{ path: NOTION_CONFIG_PATH, content: next }],
    featureBranchPrefix: "ctxpipe/notion-config",
  })
  return { changed: true, pullUrl: pull.pullUrl }
}

/** Provider capture only; the native child owns all Git mutations. */
export async function captureNotionContent(input: {
  orgId: string
  env: Env
  notionConnection: NotionConnection
  config: ParsedNotionRepoConfig
  existingPaths: string[]
  existingBlobs?: ReadonlyArray<{ path: string; sha: string }>
}): Promise<NotionSyncResult> {
  const uniqueResources = new Map<
    string,
    ParsedNotionRepoConfig["resources"][number]
  >()
  for (const resource of input.config.resources) {
    const identity = notionIdKey(resource.externalId)
    const existing = uniqueResources.get(identity)
    if (!existing || (resource.type === "page" && existing.type !== "page")) {
      uniqueResources.set(identity, resource)
    }
  }
  const resources = [...uniqueResources.values()].map((resource) => ({
    externalId: resource.externalId,
    type: resource.type,
    title: resource.title,
    url: null as string | null,
  }))
  const selectedPageIds = new Set(
    resources
      .filter((resource) => resource.type === "page")
      .map((resource) => notionIdKey(resource.externalId)),
  )
  const onTokenRefresh = createNotionTokenRefreshHandler({
    orgId: input.orgId,
    connectionId: input.notionConnection.id,
    env: input.env,
  })
  const existingShaByPath = new Map(
    (input.existingBlobs ?? []).map((entry) => [entry.path, entry.sha]),
  )
  const assetBytePool = createConnectorAssetBytePool()
  const preservePathPrefixes = new Set<string>()
  const onPreservePathPrefix = (prefix: string) => {
    preservePathPrefixes.add(prefix)
    for (const path of notionMatchingExistingAssetPaths(
      existingShaByPath.keys(),
      prefix,
    )) {
      preservePathPrefixes.add(path)
    }
  }
  const collectedPages: Array<{
    resource: (typeof resources)[number]
    entries: NotionPageTreeEntry[]
    capturedAssetsByPageId: Map<string, NotionEntityAssetCapture>
  }> = []
  const collectedDatabases: Array<{
    resource: (typeof resources)[number]
    rows: Array<{ page: NotionPage; blocks: NotionBlock[] }>
    capturedAssetsByPageId: Map<string, NotionEntityAssetCapture>
  }> = []
  const errors: Array<{ externalId: string; message: string }> = []
  let resourcesProcessed = 0
  let resourcesFailed = 0

  for (const resource of resources) {
    try {
      await withConnectorAssetBytePoolRollback(assetBytePool, async () => {
        if (resource.type !== "page") {
          const rows = await queryNotionDatabase({
            env: input.env,
            connection: input.notionConnection,
            databaseId: resource.externalId,
            onTokenRefresh,
          })
          const rowsWithBlocks = []
          const capturedAssetsByPageId = new Map<
            string,
            NotionEntityAssetCapture
          >()
          for (const row of rows) {
            if (selectedPageIds.has(notionIdKey(row.id))) continue
            const blocks = await listBlocksDeep({
              env: input.env,
              connection: input.notionConnection,
              blockId: row.id,
              onTokenRefresh,
            })
            rowsWithBlocks.push({ page: row, blocks })
            capturedAssetsByPageId.set(
              row.id,
              await captureNotionEntityAssets({
                markdownPath: getNotionDatabaseRowPath({ resource, page: row }),
                page: row,
                blocks,
                bytePool: assetBytePool,
                existingShaByPath,
              }),
            )
          }
          collectedDatabases.push({
            resource,
            rows: rowsWithBlocks,
            capturedAssetsByPageId,
          })
          resourcesProcessed += 1
          return
        }

        const capturedAssetsByPageId = new Map<
          string,
          NotionEntityAssetCapture
        >()
        const pages = await listNotionPageTree({
          env: input.env,
          connection: input.notionConnection,
          rootPageId: resource.externalId,
          skipPageIds: selectedPageIds,
          onTokenRefresh,
          onEntry: async (entry) => {
            capturedAssetsByPageId.set(
              entry.page.id,
              await captureNotionEntityAssets({
                markdownPath: getNotionPagePath({
                  page: entry.page,
                  ancestors: entry.ancestors,
                }),
                page: entry.page,
                blocks: entry.blocks,
                bytePool: assetBytePool,
                existingShaByPath,
              }),
            )
          },
        })
        collectedPages.push({
          resource,
          entries: pages,
          capturedAssetsByPageId,
        })
        resourcesProcessed += pages.length
      })
    } catch (error) {
      resourcesFailed += 1
      errors.push({
        externalId: resource.externalId,
        message:
          error instanceof Error ? error.message : "Unknown Notion sync error",
      })
    }
  }

  const pathByNotionId = new Map<string, string>()
  for (const { entries } of collectedPages) {
    for (const entry of entries) {
      pathByNotionId.set(
        notionIdKey(entry.page.id),
        getNotionPagePath({
          page: entry.page,
          ancestors: entry.ancestors,
        }),
      )
    }
  }
  for (const { resource, rows } of collectedDatabases) {
    pathByNotionId.set(
      notionIdKey(resource.externalId),
      getNotionDatabaseIndexPath(resource),
    )
    for (const { page } of rows) {
      pathByNotionId.set(
        notionIdKey(page.id),
        getNotionDatabaseRowPath({ resource, page }),
      )
    }
  }

  const filesToWrite: CommitFile[] = []
  for (const { resource, entries, capturedAssetsByPageId } of collectedPages) {
    for (const entry of entries) {
      filesToWrite.push(
        ...(await buildNotionPageMirrorFiles({
          resource,
          page: entry.page,
          blocks: entry.blocks,
          path: pathByNotionId.get(notionIdKey(entry.page.id)),
          pathByNotionId,
          bytePool: assetBytePool,
          existingShaByPath,
          ancestors: entry.ancestors,
          onPreservePathPrefix,
          capturedAssets: capturedAssetsByPageId.get(entry.page.id),
        })),
      )
    }
  }
  for (const { resource, rows, capturedAssetsByPageId } of collectedDatabases) {
    filesToWrite.push(
      ...(await buildNotionDatabaseMirrorFiles({
        resource,
        rows,
        pathByNotionId,
        bytePool: assetBytePool,
        existingShaByPath,
        onPreservePathPrefix,
        capturedAssetsByPageId,
      })),
    )
  }

  const managedRoot = getManagedNotionRootPath()
  const managedRepoFiles = (
    input.existingBlobs?.map((entry) => entry.path) ?? input.existingPaths
  ).filter((path) => path.startsWith(managedRoot) && path !== NOTION_CONFIG_PATH)
  const desiredPaths = new Set(filesToWrite.map((file) => file.path))
  const deletePaths = getNotionDeletePaths({
    managedRepoPaths: managedRepoFiles,
    desiredPaths,
    resourcesFailed,
    preservePathPrefixes: [...preservePathPrefixes],
  })
  const files = input.existingBlobs
    ? notionCommitFilesExcludingUnchanged({
        files: filesToWrite,
        existingBlobs: input.existingBlobs,
      })
    : filesToWrite

  const status: NotionSyncResult["status"] =
    resourcesFailed === 0
      ? "completed"
      : resourcesProcessed > 0
        ? "partial_failed"
        : "failed"

  return {
    status,
    resourcesProcessed,
    resourcesFailed,
    files,
    deletePaths,
    errors,
  }
}

export type NotionIncrementalSyncResult = {
  status: "completed" | "failed"
  written: number
  deleted: number
  files: Array<{ path: string; content: string }>
  deletePaths: string[]
  errors: Array<{ externalId: string; message: string }>
}

/**
 * Capture a single entity-scoped Notion change. Unlike {@link captureNotionContent},
 * this re-mirrors only the affected top-level resource (a selected page subtree or a
 * database), so live webhooks stay cheap instead of triggering a full remirror.
 */
export async function captureNotionIncrementalContent(input: {
  orgId: string
  env: Env
  notionConnection: NotionConnection
  existingPaths: string[]
  existingBlobs?: ReadonlyArray<{ path: string; sha: string }>
  config: ParsedNotionRepoConfig
  entity: NotionEntityChange
}): Promise<NotionIncrementalSyncResult> {
  const onTokenRefresh = createNotionTokenRefreshHandler({
    orgId: input.orgId,
    connectionId: input.notionConnection.id,
    env: input.env,
  })

  const managedRoot = getManagedNotionRootPath()
  const managedPaths = (
    input.existingBlobs?.map((entry) => entry.path) ?? input.existingPaths
  ).filter((path) => path.startsWith(managedRoot) && path !== NOTION_CONFIG_PATH)

  const changes = await buildNotionIncrementalChanges({
    env: input.env,
    connection: input.notionConnection,
    config: input.config,
    entity: input.entity,
    existingPaths: managedPaths,
    existingBlobs: input.existingBlobs,
    bytePool: createConnectorEntityAssetBytePool(),
    onTokenRefresh,
  })
  const files = input.existingBlobs
    ? notionCommitFilesExcludingUnchanged({
        files: changes.files,
        existingBlobs: input.existingBlobs,
      })
    : changes.files

  return {
    status: changes.failures.length > 0 ? "failed" : "completed",
    written: files.length,
    deleted: changes.deletePaths.length,
    files,
    deletePaths: changes.deletePaths,
    errors: changes.failures.map((failure) => ({
      externalId: failure.id,
      message: failure.message,
    })),
  }
}
