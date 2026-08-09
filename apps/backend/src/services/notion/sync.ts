import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import type {
  NotionBinding,
  NotionBindingWithRepo,
  NotionConnection,
} from "../../models/notion-connector.js"
import { updateNotionConnectionTokens } from "../../models/notion-connector.js"
import {
  closePullRequest,
  commitFiles,
  createPullRequestWithFiles,
  getFileContent,
  listFilesInTree,
  parseGithubPullNumberFromUrl,
} from "../github/installation-write-client.js"
import type { NotionBlock, NotionPage } from "./client.js"
import { queryNotionDatabase } from "./client.js"
import {
  loadNotionScopeFromRepo,
  NOTION_CONFIG_PATH,
} from "./config-from-repo.js"
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
  toNotionDatabaseFiles,
  toNotionMarkdownFile,
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

export type NotionSyncResult = {
  status: "completed" | "partial_failed" | "failed"
  resourcesProcessed: number
  resourcesFailed: number
  commitSha?: string
  pullUrl?: string
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
}): string[] {
  if (input.resourcesFailed > 0) return []
  return input.managedRepoPaths.filter((path) => !input.desiredPaths.has(path))
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

export async function syncNotionContent(input: {
  orgId: string
  env: Env
  notionConnection: NotionConnection
  binding: NotionBinding
  scopeFromRepo?: ParsedNotionRepoConfig
}): Promise<NotionSyncResult> {
  if (!input.binding.enabled || input.binding.setupPhase === "awaiting_merge") {
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
    (await loadNotionScopeFromRepo({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      githubConnectionId,
      branch: input.binding.branch,
    }))
  if (!repoScope) {
    throw new Error(
      "Notion scope configuration is missing from the repository; expected notion/config.yaml",
    )
  }

  const resources = repoScope.resources.map((resource) => ({
    externalId: resource.externalId,
    type: resource.type,
    title: resource.title,
    url: null as string | null,
  }))
  const onTokenRefresh = async (tokens: {
    accessToken: string
    refreshToken: string | null
  }) => {
    await withOrgDbContext(input.orgId, () =>
      updateNotionConnectionTokens({
        orgId: input.orgId,
        connectionId: input.notionConnection.id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        env: input.env,
      }),
    )
  }
  const collectedPages: Array<{
    resource: (typeof resources)[number]
    entries: NotionPageTreeEntry[]
  }> = []
  const collectedDatabases: Array<{
    resource: (typeof resources)[number]
    rows: Array<{ page: NotionPage; blocks: NotionBlock[] }>
  }> = []
  const errors: Array<{ externalId: string; message: string }> = []
  let resourcesProcessed = 0
  let resourcesFailed = 0

  for (const resource of resources) {
    try {
      if (resource.type !== "page") {
        const rows = await queryNotionDatabase({
          env: input.env,
          connection: input.notionConnection,
          databaseId: resource.externalId,
          onTokenRefresh,
        })
        const rowsWithBlocks = []
        for (const row of rows) {
          rowsWithBlocks.push({
            page: row,
            blocks: await listBlocksDeep({
              env: input.env,
              connection: input.notionConnection,
              blockId: row.id,
              onTokenRefresh,
            }),
          })
        }
        collectedDatabases.push({ resource, rows: rowsWithBlocks })
        resourcesProcessed += 1
        continue
      }

      const pages = await listNotionPageTree({
        env: input.env,
        connection: input.notionConnection,
        rootPageId: resource.externalId,
        onTokenRefresh,
      })
      collectedPages.push({ resource, entries: pages })
      resourcesProcessed += pages.length
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

  const filesToWrite: Array<{ path: string; content: string }> = []
  for (const { resource, entries } of collectedPages) {
    for (const entry of entries) {
      filesToWrite.push(
        toNotionMarkdownFile({
          resource,
          page: entry.page,
          blocks: entry.blocks,
          path: pathByNotionId.get(notionIdKey(entry.page.id)),
          pathByNotionId,
        }),
      )
    }
  }
  for (const { resource, rows } of collectedDatabases) {
    filesToWrite.push(
      ...toNotionDatabaseFiles({
        resource,
        rows,
        pathByNotionId,
      }),
    )
  }

  const managedRoot = getManagedNotionRootPath()
  const allRepoFiles = await listFilesInTree({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    branch: input.binding.branch,
    githubConnectionId,
  })
  const managedRepoFiles = allRepoFiles
    .map((entry) => entry.path)
    .filter(
      (path) => path.startsWith(managedRoot) && path !== NOTION_CONFIG_PATH,
    )
  const desiredPaths = new Set(filesToWrite.map((file) => file.path))
  const deletePaths = getNotionDeletePaths({
    managedRepoPaths: managedRepoFiles,
    desiredPaths,
    resourcesFailed,
  })

  const filesToCommit: Array<{ path: string; content: string }> = []
  for (const file of filesToWrite) {
    const current = await getFileContent({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch: input.binding.branch,
      path: file.path,
      githubConnectionId,
    })
    if (current === file.content) continue
    filesToCommit.push(file)
  }

  let commitSha: string | undefined
  if (filesToCommit.length > 0 || deletePaths.length > 0) {
    const commit = await commitFiles({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch: input.binding.branch,
      githubConnectionId,
      message: "chore(notion): sync content",
      files: filesToCommit,
      deletePaths,
    })
    commitSha = commit.commitSha
  }

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
    commitSha,
    errors,
  }
}

export type NotionIncrementalSyncResult = {
  status: "completed" | "failed"
  written: number
  deleted: number
  commitSha?: string
  errors: Array<{ externalId: string; message: string }>
}

/**
 * Apply a single entity-scoped Notion change to Git. Unlike {@link syncNotionContent},
 * this re-mirrors only the affected top-level resource (a selected page subtree or a
 * database), so live webhooks stay cheap instead of triggering a full remirror.
 */
export async function syncNotionIncrementalContent(input: {
  orgId: string
  env: Env
  notionConnection: NotionConnection
  binding: NotionBindingWithRepo
  config: ParsedNotionRepoConfig
  entity: NotionEntityChange
}): Promise<NotionIncrementalSyncResult> {
  const { repositoryName, githubConnectionId, branch } = input.binding
  if (!githubConnectionId) {
    throw new Error(
      "Notion binding repository has no GitHub connection; link the repository to a GitHub installation first",
    )
  }

  const onTokenRefresh = async (tokens: {
    accessToken: string
    refreshToken: string | null
  }) => {
    await withOrgDbContext(input.orgId, () =>
      updateNotionConnectionTokens({
        orgId: input.orgId,
        connectionId: input.notionConnection.id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        env: input.env,
      }),
    )
  }

  const managedRoot = getManagedNotionRootPath()
  const allRepoFiles = await listFilesInTree({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    branch,
    githubConnectionId,
  })
  const managedPaths = allRepoFiles
    .map((entry) => entry.path)
    .filter(
      (path) => path.startsWith(managedRoot) && path !== NOTION_CONFIG_PATH,
    )

  const changes = await buildNotionIncrementalChanges({
    env: input.env,
    connection: input.notionConnection,
    config: input.config,
    entity: input.entity,
    existingPaths: managedPaths,
    onTokenRefresh,
  })

  // Skip re-committing files whose content already matches so repeated webhooks
  // (e.g. page.content_updated) do not produce empty commits.
  const filesToCommit: Array<{ path: string; content: string }> = []
  for (const file of changes.files) {
    const current = await getFileContent({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch,
      path: file.path,
      githubConnectionId,
    })
    if (current === file.content) continue
    filesToCommit.push(file)
  }

  let commitSha: string | undefined
  if (filesToCommit.length > 0 || changes.deletePaths.length > 0) {
    const commit = await commitFiles({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch,
      githubConnectionId,
      message: "chore(notion): apply incremental updates",
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
