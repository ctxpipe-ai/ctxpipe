import slugify from "@sindresorhus/slugify"
import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import type {
  NotionConnection,
  NotionResource,
  NotionSyncTarget,
} from "../../models/notion-connector.js"
import { updateNotionResourceSyncState } from "../../models/notion-connector.js"
import {
  commitFiles,
  createPullRequestWithFiles,
  getFileContent,
  listFilesInTree,
} from "../github/installation-write-client.js"
import type { NotionBlock } from "./client.js"
import { listNotionBlockChildren, retrieveNotionPage } from "./client.js"
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
import { getManagedNotionRootPath, toNotionMarkdownFile } from "./converter.js"

export type NotionSyncResult = {
  status: "completed" | "partial_failed" | "failed"
  resourcesProcessed: number
  resourcesFailed: number
  commitSha?: string
  pullUrl?: string
  errors: Array<{ externalId: string; message: string }>
}

function safePathSegment(input: string): string {
  const s = slugify(input, { lowercase: true })
  return s.length > 0 ? s : "untitled"
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
  connection: NotionConnection
  blockId: string
  depth?: number
}): Promise<NotionBlock[]> {
  const depth = input.depth ?? 0
  const blocks = await listNotionBlockChildren({
    connection: input.connection,
    blockId: input.blockId,
  })
  if (depth >= 4) return blocks
  const result: NotionBlock[] = []
  for (const block of blocks) {
    result.push(block)
    if (block.has_children) {
      result.push(
        ...(await listBlocksDeep({
          connection: input.connection,
          blockId: block.id,
          depth: depth + 1,
        })),
      )
    }
  }
  return result
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
  const filesToWrite: Array<{ path: string; content: string }> = []
  const errors: Array<{ externalId: string; message: string }> = []
  let resourcesProcessed = 0
  let resourcesFailed = 0

  for (const resource of resources) {
    try {
      if (resource.type !== "page") {
        filesToWrite.push({
          path: `notion/databases/${safePathSegment(resource.title)}--${resource.externalId}.md`,
          content: [
            "---",
            "source: notion",
            `notion_id: ${JSON.stringify(resource.externalId)}`,
            `title: ${JSON.stringify(resource.title)}`,
            "type: database",
            "---",
            "",
            `# ${resource.title}`,
            "",
            "Database syncing is configured. Page rows will be expanded in a later connector iteration.",
            "",
          ].join("\n"),
        })
        resourcesProcessed += 1
        continue
      }

      const page = await retrieveNotionPage({
        connection: input.notionConnection,
        pageId: resource.externalId,
      })
      const blocks = await listBlocksDeep({
        connection: input.notionConnection,
        blockId: resource.externalId,
      })
      filesToWrite.push(
        toNotionMarkdownFile({
          resource,
          page,
          blocks,
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
