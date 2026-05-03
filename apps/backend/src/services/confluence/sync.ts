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
  closePullRequest,
  commitFiles,
  createPullRequestWithFiles,
  getFileContent,
  listFilesInTree,
  parseGithubPullNumberFromUrl,
} from "../github/installation-write-client.js"
import {
  type ConfluenceClientInput,
  getConfluencePageWithBody,
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
  getManagedConfluenceRootPath,
  toConfluenceMarkdownFile,
} from "./converter.js"

const CONFLUENCE_CONFIG_PATH = "confluence/config.yaml"

/** Kept in sync with Forge webhook `eventType` values. */
export const CONFLUENCE_DELETED_PAGE_EVENT =
  "avi:confluence:deleted:page" as const

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
    for (const row of scopeRows) {
      const fromScope = row.selectedPageIds as string[] | null
      if (fromScope === null) break
      if (fromScope.length === 0) {
        return {
          status: "completed",
          spacesProcessed: 0,
          pagesProcessed: 0,
          pagesFailed: 0,
          errors: [],
        }
      }
      if (!fromScope.includes(singlePageId)) {
        return {
          status: "completed",
          spacesProcessed: 0,
          pagesProcessed: 0,
          pagesFailed: 0,
          errors: [],
        }
      }
      break
    }
  }

  const spaces = await listConfluenceSpaces(input.forgeInstallation)
  const spaceIdByKey = new Map(spaces.map((space) => [space.key, space.id]))
  const filesToWrite: Array<{ path: string; content: string }> = []
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
    }

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
            selectedIds: selectedSetForTree,
            pathRootSkipPageIds,
          }),
        )
        pagesProcessed += 1
      } catch (error) {
        pagesFailed += 1
        errors.push({
          spaceKey: scopeRow.spaceKey,
          pageId: page.id,
          message:
            error instanceof Error ? error.message : "Unknown page sync error",
        })
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
  let deletePaths: string[] = []
  if (reconcileMode === "full") {
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
        (path) =>
          path.startsWith(managedRoot) && path !== CONFLUENCE_CONFIG_PATH,
      )
    const desiredPaths = new Set(filesToWrite.map((file) => file.path))
    deletePaths = managedRepoFiles.filter((path) => !desiredPaths.has(path))
  }

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
