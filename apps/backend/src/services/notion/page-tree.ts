import type { Env } from "../../config/env.js"
import type { NotionConnection } from "../../models/notion-connector.js"
import type { NotionBlock, NotionPage } from "./client.js"
import {
  getNotionPageTitle,
  listNotionBlockChildren,
  retrieveNotionPage,
} from "./client.js"

type NotionTokenRefresh = Parameters<
  typeof listNotionBlockChildren
>[0]["onTokenRefresh"]

export type NotionPageTreeEntry = {
  page: NotionPage
  blocks: NotionBlock[]
  ancestors: Array<{ id: string; title: string }>
}

export async function listBlocksDeep(input: {
  env: Env
  connection: NotionConnection
  blockId: string
  onTokenRefresh: NotionTokenRefresh
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

export async function listNotionPageTree(input: {
  env: Env
  connection: NotionConnection
  rootPageId: string
  onTokenRefresh: NotionTokenRefresh
}): Promise<NotionPageTreeEntry[]> {
  const entries: NotionPageTreeEntry[] = []
  const seen = new Set<string>()

  async function visit(
    pageId: string,
    ancestors: Array<{ id: string; title: string }>,
  ): Promise<void> {
    if (seen.has(pageId)) return
    seen.add(pageId)
    const page = await retrieveNotionPage({
      env: input.env,
      connection: input.connection,
      pageId,
      onTokenRefresh: input.onTokenRefresh,
    })
    const blocks = await listBlocksDeep({
      env: input.env,
      connection: input.connection,
      blockId: pageId,
      onTokenRefresh: input.onTokenRefresh,
    })
    entries.push({ page, blocks, ancestors })
    const nextAncestors = [
      ...ancestors,
      { id: page.id, title: getNotionPageTitle(page) },
    ]
    for (const childPageId of getNotionChildPageIds(blocks)) {
      await visit(childPageId, nextAncestors)
    }
  }

  await visit(input.rootPageId, [])
  return entries
}
