import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import type { ConfluenceSpaceSelection } from "../../models/atlassian-connector.js"
import {
  listConfluenceSpacesByConnectionId,
  updateConfluenceSpaceSyncState,
} from "../../models/atlassian-connector.js"
import type { ConfluenceSyncTarget } from "../../models/confluence-sync-target.js"
import {
  CONNECTOR_ASSET_MAX_BYTES,
  connectorAssetCommitFile,
  connectorCommitFileUnchanged,
  createConnectorAssetBudget,
  downloadConnectorAsset,
} from "../connectors/assets.js"
import type { CommitFile } from "../github/installation-write-client.js"
import {
  closePullRequest,
  commitFiles,
  createPullRequestWithFiles,
  getFileContent,
  listFilesInTree,
  parseGithubPullNumberFromUrl,
} from "../github/installation-write-client.js"
import {
  type ConfluenceAttachment,
  type ConfluenceClientInput,
  downloadConfluenceAttachment,
  getConfluencePageWithBody,
  listConfluencePageAttachments,
  listConfluencePagesForSpace,
  listConfluenceSpaces,
} from "./client.js"
import { loadConfluenceScopeFromRepo } from "./config-from-repo.js"
import type { ParsedConfluenceRepoConfig } from "./config-yaml.js"
import {
  getConfigPullRequestPayload,
  hasConfigYamlChanged,
  renderConfluenceConfigYaml,
} from "./config-yaml.js"
import {
  buildConfluenceMarkdownRelPath,
  type ConfluenceMediaResolution,
  type ConfluenceStorageMedia,
  confluenceExternalSourceKey,
  confluencePageAssetPath,
  confluencePageAssetPrefix,
  extractConfluenceStorageMedia,
  getManagedConfluenceRootPath,
  isAmbiguousLegacyConfluenceMarkdown,
  isManagedConfluenceMarkdownForPage,
  relativeConfluenceAssetHref,
  toConfluenceMarkdownFile,
} from "./converter.js"

const CONFLUENCE_CONFIG_PATH = "confluence/config.yaml"

/** Kept in sync with Forge webhook `eventType` values. */
export const CONFLUENCE_DELETED_PAGE_EVENT =
  "avi:confluence:deleted:page" as const

function stubFromFileSize(
  fileSize: number | null,
  remainingBytes: number,
): Extract<ConfluenceMediaResolution, { status: "stub" }> | undefined {
  if (fileSize == null) return undefined
  if (fileSize > CONNECTOR_ASSET_MAX_BYTES) {
    return { status: "stub", reason: "asset_limit" }
  }
  if (fileSize > remainingBytes) {
    return { status: "stub", reason: "entity_limit" }
  }
  return undefined
}

async function collectPageAssetFiles(input: {
  client: ConfluenceClientInput
  spaceKey: string
  pageId: string
  markdownPath: string
  bodyStorage: string
}): Promise<{
  assetFiles: CommitFile[]
  resolveMedia: (media: ConfluenceStorageMedia) => ConfluenceMediaResolution
  attachmentDiscoveryComplete: boolean
}> {
  const budget = createConnectorAssetBudget()
  const assetFiles: CommitFile[] = []
  const byFilename = new Map<string, ConfluenceAttachment>()
  let attachments: ConfluenceAttachment[] = []
  let attachmentDiscoveryComplete = true
  try {
    attachments = await listConfluencePageAttachments({
      client: input.client,
      pageId: input.pageId,
    })
  } catch {
    attachments = []
    attachmentDiscoveryComplete = false
  }
  for (const attachment of attachments) {
    byFilename.set(attachment.title, attachment)
  }

  const cached = new Map<string, ConfluenceMediaResolution>()

  const storeAsset = (
    sourceKey: string,
    filename: string,
    bytes: Uint8Array,
  ) => {
    const path = confluencePageAssetPath({
      spaceKey: input.spaceKey,
      pageId: input.pageId,
      sourceKey,
      filename,
    })
    assetFiles.push(connectorAssetCommitFile(path, bytes))
    return relativeConfluenceAssetHref(input.markdownPath, path)
  }

  const takeAttachment = async (
    attachment: ConfluenceAttachment,
  ): Promise<ConfluenceMediaResolution> => {
    const cacheKey = `att:${attachment.id}`
    const hit = cached.get(cacheKey)
    if (hit) return hit
    const oversized = stubFromFileSize(
      attachment.fileSize,
      budget.remainingBytes,
    )
    if (oversized) {
      cached.set(cacheKey, oversized)
      return oversized
    }
    let resolution: ConfluenceMediaResolution
    try {
      const result = await downloadConfluenceAttachment({
        client: input.client,
        downloadLink: attachment.downloadLink,
        filename: attachment.title,
        budget,
      })
      resolution =
        result.status === "downloaded"
          ? {
              status: "ok",
              href: storeAsset(attachment.id, result.filename, result.bytes),
            }
          : { status: "stub", reason: result.reason }
    } catch {
      resolution = { status: "stub", reason: "download_failed" }
    }
    cached.set(cacheKey, resolution)
    return resolution
  }

  const takeExternal = async (
    url: string,
  ): Promise<ConfluenceMediaResolution> => {
    const cacheKey = `url:${url}`
    const hit = cached.get(cacheKey)
    if (hit) return hit
    let resolution: ConfluenceMediaResolution
    try {
      const result = await downloadConnectorAsset({ url, budget })
      resolution =
        result.status === "downloaded"
          ? {
              status: "ok",
              href: storeAsset(
                confluenceExternalSourceKey(url),
                result.filename,
                result.bytes,
              ),
            }
          : { status: "stub", reason: result.reason }
    } catch {
      resolution = { status: "stub", reason: "download_failed" }
    }
    cached.set(cacheKey, resolution)
    return resolution
  }

  const inline = extractConfluenceStorageMedia(input.bodyStorage)
  const referencedFilenames = new Set<string>()
  for (const media of inline) {
    if (media.kind === "attachment") {
      referencedFilenames.add(media.filename)
      const attachment = byFilename.get(media.filename)
      if (attachment) await takeAttachment(attachment)
      else
        cached.set(`missing:${media.filename}`, {
          status: "stub",
          reason: "download_failed",
        })
    } else {
      await takeExternal(media.url)
    }
  }
  for (const attachment of attachments) {
    if (!referencedFilenames.has(attachment.title)) {
      await takeAttachment(attachment)
    }
  }

  return {
    assetFiles,
    attachmentDiscoveryComplete,
    resolveMedia: (media) => {
      if (media.kind === "external") {
        return (
          cached.get(`url:${media.url}`) ?? {
            status: "stub",
            reason: "download_failed",
          }
        )
      }
      const attachment = byFilename.get(media.filename)
      if (attachment) {
        return (
          cached.get(`att:${attachment.id}`) ?? {
            status: "stub",
            reason: "download_failed",
          }
        )
      }
      return (
        cached.get(`missing:${media.filename}`) ?? {
          status: "stub",
          reason: "download_failed",
        }
      )
    },
  }
}

type SyncModeInput = {
  spaceKey?: string
  pageId?: string
  eventType?: string
}

/**
 * - **full** — all in-scope files + GitHub orphan deletion under the managed root (config POST, space webhooks, page deleted).
 * - **single_upsert** — one page write; no global orphan pass (per-page create/update webhooks).
 */
export type ConfluenceSyncReconcileMode = "full" | "single_upsert"

export function getConfluenceSyncReconcileMode(
  mode?: SyncModeInput,
): ConfluenceSyncReconcileMode {
  if (!mode?.pageId) return "full"
  if (mode.eventType === CONFLUENCE_DELETED_PAGE_EVENT) return "full"
  return "single_upsert"
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

/** Repo YAML rows mapped into `ConfluenceSpaceSelection`-compatible shape for sync loops. */
export type RepoScopeRow = Pick<
  ConfluenceSpaceSelection,
  "spaceKey" | "selectedPageIds"
>

function normalizeSpaceRows(
  rows: RepoScopeRow[],
  mode?: SyncModeInput,
): RepoScopeRow[] {
  if (!mode?.spaceKey) return rows
  return rows.filter((row) => row.spaceKey === mode.spaceKey)
}

async function resolveRepoContextForSyncTarget(
  orgId: string,
  target: ConfluenceSyncTarget,
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

export async function syncConfluenceContent(input: {
  orgId: string
  env: Env
  forgeInstallation: ConfluenceClientInput & { id: string }
  target: ConfluenceSyncTarget
  mode?: SyncModeInput
  /** When set (e.g. push webhook), skip Git fetch — YAML already parsed */
  scopeFromRepo?: ParsedConfluenceRepoConfig
}): Promise<ConfluenceSyncResult> {
  if (!input.target.enabled) {
    return {
      status: "completed",
      spacesProcessed: 0,
      pagesProcessed: 0,
      pagesFailed: 0,
      errors: [],
    }
  }

  if (input.target.setupPhase === "awaiting_merge") {
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

  let repoScope: ParsedConfluenceRepoConfig | undefined = input.scopeFromRepo
  if (!repoScope) {
    repoScope = await loadConfluenceScopeFromRepo({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      githubConnectionId,
      branch: input.target.branch,
    })
  }
  if (!repoScope) {
    throw new Error("confluence/config.yaml is missing or invalid")
  }

  const scopeRows = normalizeSpaceRows(
    (repoScope?.spaces ?? []).map((s) => ({
      spaceKey: s.spaceKey,
      selectedPageIds: s.selectedPageIds,
    })),
    input.mode,
  )

  const reconcileMode = getConfluenceSyncReconcileMode(input.mode)
  const singlePageId =
    reconcileMode === "single_upsert" ? input.mode?.pageId : undefined

  if (singlePageId) {
    const spaceKey = input.mode?.spaceKey
    const matchingRow = spaceKey
      ? scopeRows.find((row) => row.spaceKey === spaceKey)
      : scopeRows[0]
    const selected = matchingRow?.selectedPageIds ?? undefined
    const inScope =
      matchingRow !== undefined &&
      (selected === null ||
        (selected.length > 0 && selected.includes(singlePageId)))
    if (!inScope) {
      return {
        status: "failed",
        spacesProcessed: 0,
        pagesProcessed: 0,
        pagesFailed: 1,
        errors: [
          {
            spaceKey: spaceKey ?? "",
            pageId: singlePageId,
            message: "Page is not in the repository Confluence scope",
          },
        ],
      }
    }
  }

  const spaces = await listConfluenceSpaces(input.forgeInstallation)
  const spaceIdByKey = new Map(spaces.map((space) => [space.key, space.id]))
  const filesToWrite: CommitFile[] = []
  const preservedPageIds = new Set<string>()
  const preservedAssetPrefixes: string[] = []
  const preservedSpacePrefixes: string[] = []
  const spacesWithFailedPages = new Set<string>()
  const errors: Array<{ spaceKey: string; pageId?: string; message: string }> =
    []
  let pagesProcessed = 0
  let pagesFailed = 0

  for (const scopeRow of scopeRows) {
    const spaceId = spaceIdByKey.get(scopeRow.spaceKey)
    if (!spaceId) {
      errors.push({
        spaceKey: scopeRow.spaceKey,
        message: "Confluence space not found",
      })
      preservedSpacePrefixes.push(
        `${getManagedConfluenceRootPath()}${scopeRow.spaceKey}/`,
      )
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
    const selectedForFiles = pageIdsFromScope ?? allPages.map((page) => page.id)
    const selectedSetForTree = new Set(selectedForFiles)
    const treeNodes = allPages.map((page) => ({
      id: page.id,
      title: page.title,
      parentId: page.parentId,
    }))

    let pages: typeof allPages
    if (reconcileMode === "full") {
      pages = allPages.filter((page) => selectedSetForTree.has(page.id))
    } else {
      const p = allPages.find((pg) => pg.id === singlePageId)
      pages = p ? [p] : []
      if (singlePageId && pages.length === 0) {
        pagesFailed += 1
        errors.push({
          spaceKey: scopeRow.spaceKey,
          pageId: singlePageId,
          message: "Confluence page not found",
        })
        preservedPageIds.add(singlePageId)
        preservedAssetPrefixes.push(
          confluencePageAssetPrefix(scopeRow.spaceKey, singlePageId),
        )
      }
    }

    for (const page of pages) {
      let markdownPath: string | undefined
      try {
        markdownPath = buildConfluenceMarkdownRelPath({
          spaceKey: scopeRow.spaceKey,
          pageId: page.id,
          pages: treeNodes,
          selectedIds: selectedSetForTree,
          pathRootSkipPageIds,
        })
        const pageWithBody = await getConfluencePageWithBody({
          client: input.forgeInstallation,
          pageId: page.id,
        })
        const { assetFiles, resolveMedia, attachmentDiscoveryComplete } =
          await collectPageAssetFiles({
            client: input.forgeInstallation,
            spaceKey: scopeRow.spaceKey,
            pageId: page.id,
            markdownPath,
            bodyStorage: pageWithBody.bodyStorage,
          })
        filesToWrite.push(
          toConfluenceMarkdownFile({
            spaceKey: scopeRow.spaceKey,
            pageId: page.id,
            title: page.title,
            bodyStorage: pageWithBody.bodyStorage,
            pages: treeNodes,
            selectedIds: selectedSetForTree,
            pathRootSkipPageIds,
            resolveMedia,
          }),
          ...assetFiles,
        )
        if (!attachmentDiscoveryComplete) {
          preservedAssetPrefixes.push(
            confluencePageAssetPrefix(scopeRow.spaceKey, page.id),
          )
        }
        pagesProcessed += 1
      } catch (error) {
        pagesFailed += 1
        errors.push({
          spaceKey: scopeRow.spaceKey,
          pageId: page.id,
          message:
            error instanceof Error ? error.message : "Unknown page sync error",
        })
        preservedPageIds.add(page.id)
        preservedAssetPrefixes.push(
          confluencePageAssetPrefix(scopeRow.spaceKey, page.id),
        )
        spacesWithFailedPages.add(scopeRow.spaceKey)
      }
    }

    const lastPageMarker =
      reconcileMode === "single_upsert" && singlePageId ? singlePageId : null
    await withOrgDbContext(input.orgId, () =>
      updateConfluenceSpaceSyncState({
        connectionId: input.forgeInstallation.id,
        spaceKey: scopeRow.spaceKey,
        lastSyncedAt: new Date(),
        lastSyncedPageId: lastPageMarker,
      }),
    )
  }

  const managedRoot = getManagedConfluenceRootPath()
  const allRepoFiles = await listFilesInTree({
    orgId: input.orgId,
    env: input.env,
    repositoryName,
    branch: input.target.branch,
    githubConnectionId,
  })
  const existingShaByPath = new Map(
    allRepoFiles.map((entry) => [entry.path, entry.sha]),
  )
  const desiredPaths = new Set(filesToWrite.map((file) => file.path))
  const isPreservedPath = (path: string): boolean => {
    if (
      preservedAssetPrefixes.some((prefix) => path.startsWith(prefix)) ||
      preservedSpacePrefixes.some((prefix) => path.startsWith(prefix)) ||
      [...preservedPageIds].some((pageId) =>
        isManagedConfluenceMarkdownForPage(path, pageId),
      )
    ) {
      return true
    }
    const spaceKey = path.split("/")[1]
    return (
      spaceKey !== undefined &&
      spacesWithFailedPages.has(spaceKey) &&
      isAmbiguousLegacyConfluenceMarkdown(path)
    )
  }
  let deletePaths: string[] = []
  if (reconcileMode === "full") {
    const pruneRoot = input.mode?.spaceKey
      ? `${managedRoot}${input.mode.spaceKey}/`
      : managedRoot
    deletePaths = allRepoFiles
      .map((entry) => entry.path)
      .filter(
        (path) =>
          path.startsWith(pruneRoot) &&
          path !== CONFLUENCE_CONFIG_PATH &&
          !desiredPaths.has(path) &&
          !isPreservedPath(path),
      )
  } else if (input.mode?.spaceKey && singlePageId) {
    const prefix = confluencePageAssetPrefix(input.mode.spaceKey, singlePageId)
    const spaceRoot = `${managedRoot}${input.mode.spaceKey}/`
    deletePaths = allRepoFiles
      .map((entry) => entry.path)
      .filter((path) => {
        if (desiredPaths.has(path) || isPreservedPath(path)) return false
        if (path.startsWith(prefix)) return true
        return (
          path.startsWith(spaceRoot) &&
          isManagedConfluenceMarkdownForPage(path, singlePageId)
        )
      })
  }

  const filesToCommit = filesToWrite.filter(
    (file) => !connectorCommitFileUnchanged(file, existingShaByPath),
  )

  let commitSha: string | undefined
  if (filesToCommit.length > 0 || deletePaths.length > 0) {
    const commit = await commitFiles({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      branch: input.target.branch,
      githubConnectionId,
      message: "chore(confluence): sync content",
      files: filesToCommit,
      deletePaths,
    })
    commitSha = commit.commitSha
  }

  const status: ConfluenceSyncResult["status"] =
    pagesFailed === 0
      ? "completed"
      : pagesProcessed > 0
        ? "partial_failed"
        : "failed"
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
  const scopeRows = await withOrgDbContext(input.orgId, () =>
    listConfluenceSpacesByConnectionId(input.connectionId),
  )
  const { repositoryName, githubConnectionId } =
    await resolveRepoContextForSyncTarget(input.orgId, input.target)

  const priorNum = input.target.pendingConfigPullUrl
    ? parseGithubPullNumberFromUrl(input.target.pendingConfigPullUrl)
    : undefined
  if (priorNum !== undefined) {
    await closePullRequest({
      orgId: input.orgId,
      env: input.env,
      repositoryName,
      githubConnectionId,
      pullNumber: priorNum,
      comment:
        "Closing in favor of an updated Confluence sync configuration proposal.",
    })
  }
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
