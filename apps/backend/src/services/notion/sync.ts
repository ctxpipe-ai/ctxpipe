import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import type {
  NotionConnection,
  NotionResource,
  NotionSyncTarget,
} from "../../models/notion-connector.js"
import {
  updateNotionConnectionTokens,
  updateNotionResourceSyncState,
} from "../../models/notion-connector.js"
import {
  closePullRequest,
  commitFiles,
  createPullRequestWithFiles,
  getFileContent,
  listFilesInTree,
  parseGithubPullNumberFromUrl,
} from "../github/installation-write-client.js"
import type { NotionBlock, NotionPage } from "./client.js"
import {
  getNotionPageTitle,
  listNotionBlockChildren,
  queryNotionDatabase,
  retrieveNotionPage,
} from "./client.js"
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
  getNotionPagePath,
  toNotionDatabaseMarkdownFiles,
  toNotionMarkdownFile,
} from "./converter.js"

export type NotionSyncResult = {
  status: "completed" | "partial_failed" | "failed"
  resourcesProcessed: number
  resourcesFailed: number
  commitSha?: string
  pullUrl?: string
  errors: Array<{ externalId: string; message: string }>
}

async function resolveRepoContextForSyncTarget(
  orgId: string,
  target: NotionSyncTarget,
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
          eq(repositories.id, target.repositoryId),
          eq(repositories.orgId, orgId),
        ),
      )
      .limit(1)
    if (!row?.name) {
      throw new Error("Sync target repository not found for organization")
    }
    if (!row.githubConnectionId) {
      throw new Error(
        "Sync target repository has no GitHub connection; link the repository to a GitHub installation first",
      )
    }
    return {
      repositoryName: row.name,
      githubConnectionId: row.githubConnectionId,
    }
  })
}

async function listBlocksDeep(input: {
  env: Env
  connection: NotionConnection
  blockId: string
  onTokenRefresh: Parameters<
    typeof listNotionBlockChildren
  >[0]["onTokenRefresh"]
}): Promise<NotionBlock[]> {
  const blocks = await listNotionBlockChildren({
    env: input.env,
    connection: input.connection,
    blockId: input.blockId,
    onTokenRefresh: input.onTokenRefresh,
  })
  const result: NotionBlock[] = []
  for (const block of blocks) {
    if (block.has_children) {
      result.push({
        ...block,
        children: await listBlocksDeep({
          env: input.env,
          connection: input.connection,
          blockId: block.id,
          onTokenRefresh: input.onTokenRefresh,
        }),
      })
    } else {
      result.push(block)
    }
  }
  return result
}

export function getNotionChildPageIds(blocks: NotionBlock[]): string[] {
  const ids: string[] = []
  for (const block of blocks) {
    if (block.type === "child_page") ids.push(block.id)
    if (block.children) ids.push(...getNotionChildPageIds(block.children))
  }
  return ids
}

type NotionPageTreeEntry = {
  page: NotionPage
  blocks: NotionBlock[]
  ancestors: Array<{ id: string; title: string }>
}

async function listNotionPageTree(input: {
  env: Env
  connection: NotionConnection
  rootPageId: string
  onTokenRefresh: Parameters<
    typeof listNotionBlockChildren
  >[0]["onTokenRefresh"]
}): Promise<NotionPageTreeEntry[]> {
  const entries: NotionPageTreeEntry[] = []
  const seen = new Set<string>()

  async function visit(
    pageId: string,
    ancestors: Array<{ id: string; title: string }>,
    isRoot: boolean,
  ): Promise<void> {
    if (seen.has(pageId)) return
    seen.add(pageId)
    let page: NotionPage
    try {
      page = await retrieveNotionPage({
        env: input.env,
        connection: input.connection,
        pageId,
        onTokenRefresh: input.onTokenRefresh,
      })
    } catch (error) {
      if (isRoot) throw error
      return
    }
    let blocks: NotionBlock[]
    try {
      blocks = await listBlocksDeep({
        env: input.env,
        connection: input.connection,
        blockId: pageId,
        onTokenRefresh: input.onTokenRefresh,
      })
    } catch (error) {
      if (isRoot) throw error
      return
    }
    entries.push({ page, blocks, ancestors })
    const nextAncestors = [
      ...ancestors,
      { id: page.id, title: getNotionPageTitle(page) },
    ]
    for (const childPageId of getNotionChildPageIds(blocks)) {
      await visit(childPageId, nextAncestors, false)
    }
  }

  await visit(input.rootPageId, [], true)
  return entries
}

function resourcesFromRepoScope(
  repoScope: ParsedNotionRepoConfig | undefined,
  fallback: NotionResource[],
): Array<Pick<NotionResource, "externalId" | "type" | "title" | "url">> {
  if (!repoScope) return fallback
  const savedById = new Map(
    fallback.map((resource) => [resource.externalId, resource]),
  )
  return repoScope.resources.map((resource) => {
    const saved = savedById.get(resource.externalId)
    return {
      externalId: resource.externalId,
      type: resource.type,
      title: resource.title || saved?.title || "Untitled",
      url: saved?.url ?? null,
    }
  })
}

export async function syncNotionConfigYaml(input: {
  orgId: string
  orgSlug: string
  env: Env
  connectionId: string
  target: NotionSyncTarget
  resources: NotionResource[]
}): Promise<{ changed: boolean; pullUrl?: string }> {
  const { repositoryName, githubConnectionId } =
    await resolveRepoContextForSyncTarget(input.orgId, input.target)
  const current = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    githubConnectionId,
    branch: input.target.branch,
    path: NOTION_CONFIG_PATH,
  })
  const next = renderNotionConfigYaml({
    resources: input.resources.map((resource) => ({
      externalId: resource.externalId,
      type: resource.type,
      title: resource.title,
    })),
  })
  const priorPullNumber = input.target.pendingConfigPullUrl
    ? parseGithubPullNumberFromUrl(input.target.pendingConfigPullUrl)
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
    baseBranch: input.target.branch,
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
  target: NotionSyncTarget
  resources: NotionResource[]
  scopeFromRepo?: ParsedNotionRepoConfig
}): Promise<NotionSyncResult> {
  if (!input.target.enabled || input.target.setupPhase === "awaiting_merge") {
    return {
      status: "completed",
      resourcesProcessed: 0,
      resourcesFailed: 0,
      errors: [],
    }
  }

  const { repositoryName, githubConnectionId } =
    await resolveRepoContextForSyncTarget(input.orgId, input.target)
  const repoScope =
    input.scopeFromRepo ??
    (await loadNotionScopeFromRepo({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      githubConnectionId,
      branch: input.target.branch,
    }))

  const resources = resourcesFromRepoScope(repoScope, input.resources)
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
      }),
    )
  }
  const filesToWrite: Array<{ path: string; content: string }> = []
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
        filesToWrite.push(
          ...toNotionDatabaseMarkdownFiles({
            resource,
            rows: rowsWithBlocks,
          }),
        )
        resourcesProcessed += 1
        await withOrgDbContext(input.orgId, () =>
          updateNotionResourceSyncState({
            connectionId: input.notionConnection.id,
            externalId: resource.externalId,
            lastSyncedAt: new Date(),
          }),
        )
        continue
      }

      const pages = await listNotionPageTree({
        env: input.env,
        connection: input.notionConnection,
        rootPageId: resource.externalId,
        onTokenRefresh,
      })
      for (const entry of pages) {
        filesToWrite.push(
          toNotionMarkdownFile({
            resource,
            page: entry.page,
            blocks: entry.blocks,
            path: getNotionPagePath({
              page: entry.page,
              ancestors: entry.ancestors,
            }),
          }),
        )
      }
      resourcesProcessed += pages.length
      await withOrgDbContext(input.orgId, () =>
        updateNotionResourceSyncState({
          connectionId: input.notionConnection.id,
          externalId: resource.externalId,
          lastSyncedAt: new Date(),
        }),
      )
    } catch (error) {
      resourcesFailed += 1
      errors.push({
        externalId: resource.externalId,
        message:
          error instanceof Error ? error.message : "Unknown Notion sync error",
      })
    }
  }

  const managedRoot = getManagedNotionRootPath()
  const allRepoFiles = await listFilesInTree({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    branch: input.target.branch,
    githubConnectionId,
  })
  const managedRepoFiles = allRepoFiles
    .map((entry) => entry.path)
    .filter(
      (path) => path.startsWith(managedRoot) && path !== NOTION_CONFIG_PATH,
    )
  const desiredPaths = new Set(filesToWrite.map((file) => file.path))
  const deletePaths = managedRepoFiles.filter((path) => !desiredPaths.has(path))

  const filesToCommit: Array<{ path: string; content: string }> = []
  for (const file of filesToWrite) {
    const current = await getFileContent({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch: input.target.branch,
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
      branch: input.target.branch,
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
