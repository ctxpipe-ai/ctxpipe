import type { Env } from "../../config/env.js"
import type { NotionConnection } from "../../models/notion-connector.js"

const NOTION_API_BASE = "https://api.notion.com/v1"
const NOTION_VERSION = "2022-06-28"

type NotionParent =
  | { type: "page_id"; page_id: string }
  | { type: "database_id"; database_id: string }
  | { type: "workspace"; workspace: true }
  | { type: string }

export type NotionSearchResource = {
  id: string
  type: "page" | "database"
  title: string
  url: string | null
  parentExternalId: string | null
}

export type NotionBlock = {
  id: string
  type: string
  has_children?: boolean
  [key: string]: unknown
}

export type NotionPage = {
  id: string
  url?: string
  parent?: NotionParent
  last_edited_time?: string
  properties?: Record<string, unknown>
}

export type NotionTokenResponse = {
  access_token: string
  refresh_token?: string
  bot_id: string
  workspace_id?: string
  workspace_name?: string
  workspace_icon?: string | null
  owner?: { user?: { id?: string } }
}

function assertNotionOAuthConfigured(env: Env) {
  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    throw new Error("Notion OAuth is not configured")
  }
}

export function getNotionOAuthAuthorizeUrl(input: {
  env: Env
  redirectUri: string
  state: string
}) {
  assertNotionOAuthConfigured(input.env)
  const clientId = input.env.NOTION_CLIENT_ID
  if (!clientId) throw new Error("Notion OAuth is not configured")
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    owner: "user",
    redirect_uri: input.redirectUri,
    state: input.state,
  })
  return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`
}

export async function exchangeNotionOAuthCode(input: {
  env: Env
  code: string
  redirectUri: string
}): Promise<NotionTokenResponse> {
  assertNotionOAuthConfigured(input.env)
  const credentials = Buffer.from(
    `${input.env.NOTION_CLIENT_ID}:${input.env.NOTION_CLIENT_SECRET}`,
  ).toString("base64")
  const res = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  })
  if (!res.ok) {
    throw new Error(`Notion OAuth token exchange failed (${res.status})`)
  }
  return (await res.json()) as NotionTokenResponse
}

async function fetchNotion<T>(
  connection: Pick<NotionConnection, "accessToken">,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!connection.accessToken) {
    throw new Error("Notion connection has no access token")
  }
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${connection.accessToken}`,
      "notion-version": NOTION_VERSION,
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    throw new Error(`Notion API request failed (${res.status})`)
  }
  return (await res.json()) as T
}

function parentExternalId(parent: NotionParent | undefined): string | null {
  if (!parent) return null
  if (parent.type === "page_id" && "page_id" in parent) return parent.page_id
  if (parent.type === "database_id" && "database_id" in parent) {
    return parent.database_id
  }
  return null
}

function richTextPlainText(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value
    .map((part) =>
      part &&
      typeof part === "object" &&
      "plain_text" in part &&
      typeof part.plain_text === "string"
        ? part.plain_text
        : "",
    )
    .join("")
    .trim()
}

function pageTitle(properties: Record<string, unknown> | undefined): string {
  if (!properties) return "Untitled"
  for (const value of Object.values(properties)) {
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "title" &&
      "title" in value
    ) {
      const title = richTextPlainText(value.title)
      if (title) return title
    }
  }
  return "Untitled"
}

function databaseTitle(title: unknown): string {
  const value = richTextPlainText(title)
  return value || "Untitled database"
}

export async function searchNotionResources(input: {
  connection: NotionConnection
  query?: string
}): Promise<NotionSearchResource[]> {
  const items: NotionSearchResource[] = []
  let cursor: string | undefined
  do {
    const body: Record<string, unknown> = {
      page_size: 50,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    }
    if (input.query?.trim()) body.query = input.query.trim()
    if (cursor) body.start_cursor = cursor
    const data = await fetchNotion<{
      results: Array<{
        object: "page" | "database"
        id: string
        url?: string
        parent?: NotionParent
        properties?: Record<string, unknown>
        title?: unknown
      }>
      next_cursor?: string | null
      has_more?: boolean
    }>(input.connection, "/search", {
      method: "POST",
      body: JSON.stringify(body),
    })
    for (const result of data.results) {
      if (result.object !== "page" && result.object !== "database") continue
      items.push({
        id: result.id,
        type: result.object,
        title:
          result.object === "page"
            ? pageTitle(result.properties)
            : databaseTitle(result.title),
        url: result.url ?? null,
        parentExternalId: parentExternalId(result.parent),
      })
    }
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined
  } while (cursor && items.length < 200)

  return items
}

export async function retrieveNotionPage(input: {
  connection: NotionConnection
  pageId: string
}): Promise<NotionPage> {
  return fetchNotion<NotionPage>(
    input.connection,
    `/pages/${encodeURIComponent(input.pageId)}`,
  )
}

export async function listNotionBlockChildren(input: {
  connection: NotionConnection
  blockId: string
}): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = []
  let cursor: string | undefined
  do {
    const params = new URLSearchParams({ page_size: "100" })
    if (cursor) params.set("start_cursor", cursor)
    const data = await fetchNotion<{
      results: NotionBlock[]
      next_cursor?: string | null
      has_more?: boolean
    }>(
      input.connection,
      `/blocks/${encodeURIComponent(input.blockId)}/children?${params.toString()}`,
    )
    blocks.push(...data.results)
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined
  } while (cursor)
  return blocks
}

export function getNotionPageTitle(page: NotionPage): string {
  return pageTitle(page.properties)
}
