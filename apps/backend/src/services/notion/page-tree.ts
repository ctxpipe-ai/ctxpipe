import type { Env } from "../../config/env.js"
import type { NotionConnection } from "../../models/notion-connector.js"
import type { NotionBlock, NotionPage } from "./client.js"
import {
  getNotionPageTitle,
  listNotionBlockChildren,
  NotionApiError,
  retrieveNotionPage,
} from "./client.js"
import { notionIdKey } from "./converter.js"

type NotionTokenRefresh = Parameters<
  typeof listNotionBlockChildren
>[0]["onTokenRefresh"]

/**
 * Called for a page or block below the root that Notion does not let ctxpipe
 * read (403) or that is gone (404). With it, the walk skips that part and
 * goes on; without it, the walk fails.
 */
export type NotionUnreadableHandler = (
  id: string,
  error: NotionApiError,
) => void

function skippable(
  error: unknown,
  onUnreadable: NotionUnreadableHandler | undefined,
): error is NotionApiError {
  return Boolean(
    onUnreadable &&
    error instanceof NotionApiError &&
    (error.status === 403 || error.status === 404),
  )
}

export type NotionPageTreeEntry = {
  page: NotionPage
  blocks: NotionBlock[]
  ancestors: Array<{ id: string; title: string }>
  /** The folder title of the root entry when `rootTitle` is set. */
  pathTitle?: string
}

export async function listBlocksDeep(input: {
  env: Env
  connection: NotionConnection
  blockId: string
  onTokenRefresh: NotionTokenRefresh
  onUnreadable?: NotionUnreadableHandler
}): Promise<NotionBlock[]> {
  const blocks = await listNotionBlockChildren({
    env: input.env,
    connection: input.connection,
    blockId: input.blockId,
    onTokenRefresh: input.onTokenRefresh,
  })
  const result: NotionBlock[] = []
  for (const block of blocks) {
    if (block.has_children && block.type !== "child_page") {
      result.push({
        ...block,
        children: await listBlocksDeep({
          env: input.env,
          connection: input.connection,
          blockId: block.id,
          onTokenRefresh: input.onTokenRefresh,
          onUnreadable: input.onUnreadable,
        }).catch((error: unknown) => {
          if (!skippable(error, input.onUnreadable)) throw error
          input.onUnreadable?.(block.id, error)
          return []
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

export async function listNotionPageTree(input: {
  env: Env
  connection: NotionConnection
  rootPageId: string
  onTokenRefresh: NotionTokenRefresh
  onEntry?: (entry: NotionPageTreeEntry) => Promise<void>
  skipPageIds?: ReadonlySet<string>
  /** Name the root folder with this title, not the root page title. */
  rootTitle?: string
  /** Skip unreadable pages and blocks below the root (Workspace sources). */
  onUnreadable?: NotionUnreadableHandler
}): Promise<NotionPageTreeEntry[]> {
  const entries: NotionPageTreeEntry[] = []
  const seen = new Set<string>()
  const rootPageKey = notionIdKey(input.rootPageId)
  const skipPageKeys = new Set(
    [...(input.skipPageIds ?? [])].map((id) => notionIdKey(id)),
  )

  async function visit(
    pageId: string,
    ancestors: Array<{ id: string; title: string }>,
  ): Promise<void> {
    const pageKey = notionIdKey(pageId)
    if (pageKey !== rootPageKey && skipPageKeys.has(pageKey)) return
    if (seen.has(pageKey)) return
    seen.add(pageKey)
    let page: NotionPage
    let blocks: NotionBlock[]
    try {
      page = await retrieveNotionPage({
        env: input.env,
        connection: input.connection,
        pageId,
        onTokenRefresh: input.onTokenRefresh,
      })
      blocks = await listBlocksDeep({
        env: input.env,
        connection: input.connection,
        blockId: pageId,
        onTokenRefresh: input.onTokenRefresh,
        onUnreadable: input.onUnreadable,
      })
    } catch (error) {
      // The root itself must be readable; a child page is skipped.
      if (pageKey === rootPageKey || !skippable(error, input.onUnreadable))
        throw error
      input.onUnreadable?.(pageId, error)
      return
    }
    const pathTitle = pageKey === rootPageKey ? input.rootTitle : undefined
    const entry = {
      page,
      blocks,
      ancestors,
      ...(pathTitle ? { pathTitle } : {}),
    }
    entries.push(entry)
    await input.onEntry?.(entry)
    const nextAncestors = [
      ...ancestors,
      { id: page.id, title: pathTitle ?? getNotionPageTitle(page) },
    ]
    for (const childPageId of getNotionChildPageIds(blocks)) {
      await visit(childPageId, nextAncestors)
    }
  }

  await visit(input.rootPageId, [])
  return entries
}
