import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import type { ConfluenceSpaceSelection } from "../../models/atlassian-connector.js"
import {
  listConfluenceSpacesByConnectionId,
  updateConfluenceSpaceSyncState,
} from "../../models/atlassian-connector.js"
import type { ConfluenceSyncTarget } from "../../models/confluence-sync-target.js"
import {
  commitFiles,
  createPullRequestWithFiles,
  getFileContent,
  listFilesInTree,
} from "../github/installation-write-client.js"
import {
  getConfigPullRequestPayload,
  hasConfigYamlChanged,
  renderConfluenceConfigYaml,
} from "./config-yaml.js"
import {
  getConfluencePageWithBody,
  listConfluencePagesForSpace,
  listConfluenceSpaces,
  type ConfluenceClientInput,
} from "./client.js"
import {
  getManagedConfluenceRootPath,
  toConfluenceMarkdownFile,
} from "./converter.js"

const CONFLUENCE_CONFIG_PATH = "confluence/config.yaml"

type SyncModeInput = {
  spaceKey?: string
  pageId?: string
  eventType?: string
}

export type ConfluenceSyncResult = {
  status: "completed" | "partial_failed" | "failed"
  spacesProcessed: number
  pagesProcessed: number
  pagesFailed: number
  commitSha?: string
  pullUrl?: string
  errors: Array<{ spaceKey: string; pageId?: string; message: string }>
}

function normalizeSpaceRows(
  rows: ConfluenceSpaceSelection[],
  mode?: SyncModeInput,
): ConfluenceSpaceSelection[] {
  if (!mode?.spaceKey) return rows
  return rows.filter((row) => row.spaceKey === mode.spaceKey)
}

async function resolveRepoContextForSyncTarget(
  orgId: string,
  target: ConfluenceSyncTarget,
): Promise<{ repositoryName: string; githubConnectionId: string }> {
  const db = getSystemDb()
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
  return { repositoryName: row.name, githubConnectionId: row.githubConnectionId }
}

export async function syncConfluenceContent(input: {
  orgId: string
  env: Env
  forgeInstallation: ConfluenceClientInput & { id: string }
  target: ConfluenceSyncTarget
  mode?: SyncModeInput
}): Promise<ConfluenceSyncResult> {
  const scopeRows = normalizeSpaceRows(
    await listConfluenceSpacesByConnectionId(input.forgeInstallation.id),
    input.mode,
  )

  if (scopeRows.length === 0 || !input.target.enabled) {
    return {
      status: "completed",
      spacesProcessed: 0,
      pagesProcessed: 0,
      pagesFailed: 0,
      errors: [],
    }
  }

  const { repositoryName, githubConnectionId } =
    await resolveRepoContextForSyncTarget(input.orgId, input.target)

  const spaces = await listConfluenceSpaces(input.forgeInstallation)
  const spaceIdByKey = new Map(spaces.map((space) => [space.key, space.id]))
  const filesToWrite: Array<{ path: string; content: string }> = []
  const errors: Array<{ spaceKey: string; pageId?: string; message: string }> = []
  let pagesProcessed = 0
  let pagesFailed = 0

  for (const scopeRow of scopeRows) {
    const spaceId = spaceIdByKey.get(scopeRow.spaceKey)
    if (!spaceId) {
      errors.push({
        spaceKey: scopeRow.spaceKey,
        message: "Confluence space not found",
      })
      continue
    }

    const allPages = await listConfluencePagesForSpace({
      client: input.forgeInstallation,
      spaceId,
    })
    const spaceMeta = spaces.find((s) => s.key === scopeRow.spaceKey)
    const pathRootSkipPageIds = new Set(
      spaceMeta?.homepageId ? [spaceMeta.homepageId] : [],
    )
    const pageIdsFromScope = scopeRow.selectedPageIds as string[] | null
    const selectedPageIds = input.mode?.pageId
      ? [input.mode.pageId]
      : pageIdsFromScope ?? allPages.map((page) => page.id)
    const selectedSet = new Set(selectedPageIds)
    const pages = allPages.filter((page) => selectedSet.has(page.id))
    const treeNodes = allPages.map((page) => ({
      id: page.id,
      title: page.title,
      parentId: page.parentId,
    }))

    for (const page of pages) {
      try {
        const pageWithBody = await getConfluencePageWithBody({
          client: input.forgeInstallation,
          pageId: page.id,
        })
        filesToWrite.push(
          toConfluenceMarkdownFile({
            spaceKey: scopeRow.spaceKey,
            pageId: page.id,
            title: page.title,
            bodyStorage: pageWithBody.bodyStorage,
            pages: treeNodes,
            selectedIds: selectedSet,
            pathRootSkipPageIds,
          }),
        )
        pagesProcessed += 1
      } catch (error) {
        pagesFailed += 1
        errors.push({
          spaceKey: scopeRow.spaceKey,
          pageId: page.id,
          message: error instanceof Error ? error.message : "Unknown page sync error",
        })
      }
    }

    await updateConfluenceSpaceSyncState({
      connectionId: input.forgeInstallation.id,
      spaceKey: scopeRow.spaceKey,
      lastSyncedAt: new Date(),
      lastSyncedPageId: input.mode?.pageId ?? null,
    })
  }

  const managedRoot = getManagedConfluenceRootPath()
  const allRepoFiles = await listFilesInTree({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    branch: input.target.branch,
    githubConnectionId,
  })
  const managedRepoFiles = allRepoFiles
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(managedRoot) && path !== CONFLUENCE_CONFIG_PATH)
  const desiredPaths = new Set(filesToWrite.map((file) => file.path))
  const deletePaths = managedRepoFiles.filter((path) => !desiredPaths.has(path))

  let commitSha: string | undefined
  if (filesToWrite.length > 0 || deletePaths.length > 0) {
    const commit = await commitFiles({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch: input.target.branch,
      githubConnectionId,
      message: "chore(confluence): sync content",
      files: filesToWrite,
      deletePaths,
    })
    commitSha = commit.commitSha
  }

  const status: ConfluenceSyncResult["status"] =
    pagesFailed === 0 ? "completed" : pagesProcessed > 0 ? "partial_failed" : "failed"
  return {
    status,
    spacesProcessed: scopeRows.length,
    pagesProcessed,
    pagesFailed,
    commitSha,
    errors,
  }
}

export async function syncConfluenceConfigYaml(input: {
  orgId: string
  orgSlug: string
  env: Env
  connectionId: string
  target: ConfluenceSyncTarget
}): Promise<{ pullUrl?: string; changed: boolean }> {
  const scopeRows =
    await listConfluenceSpacesByConnectionId(input.connectionId)
  const { repositoryName, githubConnectionId } =
    await resolveRepoContextForSyncTarget(input.orgId, input.target)
  const yaml = renderConfluenceConfigYaml({
    spaces: scopeRows.map((row) => ({
      spaceKey: row.spaceKey,
      selectedPageIds: (row.selectedPageIds as string[] | null) ?? null,
    })),
  })
  const current = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    branch: input.target.branch,
    path: CONFLUENCE_CONFIG_PATH,
    githubConnectionId,
  })
  if (!hasConfigYamlChanged({ current, next: yaml })) {
    return { changed: false }
  }
  const pr = getConfigPullRequestPayload({ orgSlug: input.orgSlug })
  const created = await createPullRequestWithFiles({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    githubConnectionId,
    baseBranch: input.target.branch,
    title: pr.title,
    body: pr.body,
    commitMessage: pr.commitMessage,
    files: [{ path: CONFLUENCE_CONFIG_PATH, content: yaml }],
  })
  return { pullUrl: created.pullUrl, changed: true }
}
