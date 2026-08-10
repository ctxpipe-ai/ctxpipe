import type { Env } from "../../config/env.js"
import type { NotionConnection } from "../../models/notion-connector.js"
import type { NotionPage } from "./client.js"
import { queryNotionDatabase, retrieveNotionPage } from "./client.js"
import type { ParsedNotionRepoConfig } from "./config-yaml.js"
import {
  getManagedNotionRootPath,
  getNotionDatabaseIndexPath,
  getNotionDatabaseRowPath,
  getNotionPagePath,
  notionIdKey,
  toNotionDatabaseFiles,
  toNotionMarkdownFile,
} from "./converter.js"
import { listBlocksDeep, listNotionPageTree } from "./page-tree.js"

type NotionTokenRefresh = (tokens: {
  accessToken: string
  refreshToken: string | null
}) => Promise<void>

/** File the mirror wants to write, matching the shape `commitFiles` expects. */
export type NotionMirrorFile = { path: string; content: string }

/**
 * Webhook entity types Notion delivers for live updates. `data_source` is Notion's
 * 2025+ model for the queryable table behind a database; it maps onto the same
 * `database` resource we store in `notion/config.yaml`, so both re-mirror the
 * database. `database` (the container) is handled identically for completeness.
 */
export type NotionEntityType = "page" | "database" | "data_source"

export type NotionEntityChange = {
  entityType: NotionEntityType
  externalId: string
  action: "upsert" | "delete"
}

export type NotionIncrementalChanges = {
  files: NotionMirrorFile[]
  deletePaths: string[]
  failures: Array<{ type: string; id: string; message: string }>
}

const NOTION_PARENT_WALK_MAX_DEPTH = 25

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Extract the trailing Notion id encoded in a `{slug}--{id}` path segment. */
export function notionSegmentId(segment: string): string {
  const marker = segment.lastIndexOf("--")
  return marker === -1 ? "" : segment.slice(marker + 2)
}

function pathSegments(path: string): string[] {
  return path.split("/")
}

/** Managed database files (index/csv/rows) for a single database resource id. */
export function managedNotionDatabasePaths(
  paths: string[],
  databaseExternalId: string,
): string[] {
  const wanted = notionIdKey(databaseExternalId)
  return paths.filter((path) => {
    const segments = pathSegments(path)
    if (segments[0] !== "notion" || segments[1] !== "databases") return false
    const dbSegment = segments[2]
    if (dbSegment === undefined) return false
    return notionIdKey(notionSegmentId(dbSegment)) === wanted
  })
}

/** Managed page files whose top-level subtree belongs to a selected root page. */
export function managedNotionPagePathsForRoot(
  paths: string[],
  rootPageId: string,
): string[] {
  const wanted = notionIdKey(rootPageId)
  return paths.filter((path) => {
    const segments = pathSegments(path)
    if (segments[0] !== "notion" || segments[1] !== "pages") return false
    const rootSegment = segments[2]
    if (rootSegment === undefined) return false
    return notionIdKey(notionSegmentId(rootSegment)) === wanted
  })
}

/**
 * Managed page files for a page and all of its descendants (any directory
 * segment in the path encodes the id). Used when a page is deleted or leaves
 * scope so its whole subtree is removed.
 */
export function managedNotionPagePathsForSubtree(
  paths: string[],
  pageId: string,
): string[] {
  const wanted = notionIdKey(pageId)
  return paths.filter((path) => {
    const segments = pathSegments(path)
    if (segments[0] !== "notion" || segments[1] !== "pages") return false
    // Directory segments only (skip "notion", "pages", and the trailing file).
    return segments
      .slice(2, -1)
      .some((segment) => notionIdKey(notionSegmentId(segment)) === wanted)
  })
}

type NotionScopeResource = ParsedNotionRepoConfig["resources"][number]

function resourceMaps(config: ParsedNotionRepoConfig): {
  pages: Map<string, NotionScopeResource>
  databases: Map<string, NotionScopeResource>
} {
  const pages = new Map<string, NotionScopeResource>()
  const databases = new Map<string, NotionScopeResource>()
  for (const resource of config.resources) {
    const key = notionIdKey(resource.externalId)
    if (resource.type === "page") pages.set(key, resource)
    else databases.set(key, resource)
  }
  return { pages, databases }
}

function parentDatabaseLikeId(page: NotionPage): string | undefined {
  const parent = page.parent as Record<string, unknown> | undefined
  if (!parent) return undefined
  for (const key of ["data_source_id", "database_id"]) {
    const value = parent[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  const dataSource = parent.data_source
  if (
    dataSource &&
    typeof dataSource === "object" &&
    "id" in dataSource &&
    typeof (dataSource as { id?: unknown }).id === "string"
  ) {
    return (dataSource as { id: string }).id
  }
  return undefined
}

function parentPageId(page: NotionPage): string | undefined {
  const parent = page.parent as Record<string, unknown> | undefined
  if (!parent || parent.type !== "page_id") return undefined
  const value = parent.page_id
  return typeof value === "string" && value.length > 0 ? value : undefined
}

type ResolvedTarget =
  | { kind: "page"; resource: NotionScopeResource }
  | { kind: "database"; resource: NotionScopeResource }
  | undefined

/**
 * Walk a page's ancestors to find the selected root that owns it. A page is in
 * scope when it (or an ancestor) is a selected page resource, or when it is a
 * row under a selected database/data source. Returns `undefined` when out of
 * scope so callers can enforce the current git scope.
 */
async function resolvePageTarget(input: {
  env: Env
  connection: NotionConnection
  page: NotionPage
  pages: Map<string, NotionScopeResource>
  databases: Map<string, NotionScopeResource>
  onTokenRefresh?: NotionTokenRefresh
}): Promise<ResolvedTarget> {
  const selfPage = input.pages.get(notionIdKey(input.page.id))
  if (selfPage) return { kind: "page", resource: selfPage }

  let current = input.page
  for (let depth = 0; depth < NOTION_PARENT_WALK_MAX_DEPTH; depth += 1) {
    const dbLikeId = parentDatabaseLikeId(current)
    if (dbLikeId) {
      const database = input.databases.get(notionIdKey(dbLikeId))
      return database ? { kind: "database", resource: database } : undefined
    }
    const parentId = parentPageId(current)
    if (!parentId) return undefined
    const parentResource = input.pages.get(notionIdKey(parentId))
    if (parentResource) return { kind: "page", resource: parentResource }
    current = await retrieveNotionPage({
      env: input.env,
      connection: input.connection,
      pageId: parentId,
      onTokenRefresh: input.onTokenRefresh,
    })
  }
  return undefined
}

async function collectPageResourceFiles(input: {
  env: Env
  connection: NotionConnection
  resource: NotionScopeResource
  onTokenRefresh?: NotionTokenRefresh
}): Promise<NotionMirrorFile[]> {
  const entries = await listNotionPageTree({
    env: input.env,
    connection: input.connection,
    rootPageId: input.resource.externalId,
    onTokenRefresh: input.onTokenRefresh,
  })
  const pathByNotionId = new Map<string, string>()
  for (const entry of entries) {
    pathByNotionId.set(
      notionIdKey(entry.page.id),
      getNotionPagePath({ page: entry.page, ancestors: entry.ancestors }),
    )
  }
  return entries.map((entry) =>
    toNotionMarkdownFile({
      resource: input.resource,
      page: entry.page,
      blocks: entry.blocks,
      path: pathByNotionId.get(notionIdKey(entry.page.id)),
      pathByNotionId,
    }),
  )
}

async function collectDatabaseResourceFiles(input: {
  env: Env
  connection: NotionConnection
  resource: NotionScopeResource
  onTokenRefresh?: NotionTokenRefresh
}): Promise<NotionMirrorFile[]> {
  const rows = await queryNotionDatabase({
    env: input.env,
    connection: input.connection,
    databaseId: input.resource.externalId,
    onTokenRefresh: input.onTokenRefresh,
  })
  const rowsWithBlocks = []
  for (const row of rows) {
    rowsWithBlocks.push({
      page: row,
      blocks: await listBlocksDeep({
        env: input.env,
        connection: input.connection,
        blockId: row.id,
        onTokenRefresh: input.onTokenRefresh,
      }),
    })
  }
  const pathByNotionId = new Map<string, string>()
  pathByNotionId.set(
    notionIdKey(input.resource.externalId),
    getNotionDatabaseIndexPath(input.resource),
  )
  for (const { page } of rowsWithBlocks) {
    pathByNotionId.set(
      notionIdKey(page.id),
      getNotionDatabaseRowPath({ resource: input.resource, page }),
    )
  }
  return toNotionDatabaseFiles({
    resource: input.resource,
    rows: rowsWithBlocks,
    pathByNotionId,
  })
}

/**
 * Compute the file writes and deletions for a single entity-scoped Notion
 * change. Re-mirrors only the affected top-level resource (a page subtree or a
 * database) and, on failure, returns the error rather than committing a partial
 * mirror so the caller can retry.
 */
export async function buildNotionIncrementalChanges(input: {
  env: Env
  connection: NotionConnection
  config: ParsedNotionRepoConfig
  entity: NotionEntityChange
  existingPaths: string[]
  onTokenRefresh?: NotionTokenRefresh
}): Promise<NotionIncrementalChanges> {
  // Only ever look at files under the managed root so we never touch config.yaml
  // or unrelated repository content.
  const managedRoot = getManagedNotionRootPath()
  const existingPaths = input.existingPaths.filter((path) =>
    path.startsWith(managedRoot),
  )
  const { pages, databases } = resourceMaps(input.config)
  const files: NotionMirrorFile[] = []
  const deletePaths = new Set<string>()
  const failures: NotionIncrementalChanges["failures"] = []

  const applyDatabaseResource = async (
    resource: NotionScopeResource,
    externalId: string,
  ) => {
    const built = await collectDatabaseResourceFiles({
      env: input.env,
      connection: input.connection,
      resource,
      onTokenRefresh: input.onTokenRefresh,
    })
    const desired = new Set(built.map((file) => file.path))
    for (const file of built) files.push(file)
    for (const path of managedNotionDatabasePaths(existingPaths, externalId)) {
      if (!desired.has(path)) deletePaths.add(path)
    }
  }

  const applyPageResource = async (resource: NotionScopeResource) => {
    const built = await collectPageResourceFiles({
      env: input.env,
      connection: input.connection,
      resource,
      onTokenRefresh: input.onTokenRefresh,
    })
    const desired = new Set(built.map((file) => file.path))
    for (const file of built) files.push(file)
    for (const path of managedNotionPagePathsForRoot(
      existingPaths,
      resource.externalId,
    )) {
      if (!desired.has(path)) deletePaths.add(path)
    }
  }

  try {
    const { entityType, externalId, action } = input.entity
    if (entityType === "database" || entityType === "data_source") {
      const resource = databases.get(notionIdKey(externalId))
      if (action === "delete" || !resource) {
        for (const path of managedNotionDatabasePaths(
          existingPaths,
          externalId,
        )) {
          deletePaths.add(path)
        }
      } else {
        await applyDatabaseResource(resource, externalId)
      }
    } else {
      if (action === "delete") {
        for (const path of managedNotionPagePathsForSubtree(
          existingPaths,
          externalId,
        )) {
          deletePaths.add(path)
        }
      } else {
        const page = await retrieveNotionPage({
          env: input.env,
          connection: input.connection,
          pageId: externalId,
          onTokenRefresh: input.onTokenRefresh,
        })
        const target = await resolvePageTarget({
          env: input.env,
          connection: input.connection,
          page,
          pages,
          databases,
          onTokenRefresh: input.onTokenRefresh,
        })
        if (!target) {
          for (const path of managedNotionPagePathsForSubtree(
            existingPaths,
            externalId,
          )) {
            deletePaths.add(path)
          }
        } else if (target.kind === "database") {
          await applyDatabaseResource(
            target.resource,
            target.resource.externalId,
          )
        } else {
          await applyPageResource(target.resource)
        }
      }
    }
  } catch (error) {
    failures.push({
      type: input.entity.entityType,
      id: input.entity.externalId,
      message: errorMessage(error),
    })
  }

  return {
    files,
    deletePaths: [...deletePaths],
    failures,
  }
}
