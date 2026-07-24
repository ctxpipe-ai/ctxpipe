import type { Env } from "../../config/env.js"
import type { NotionConnection } from "../../models/notion-connector.js"

const NOTION_API_BASE = "https://api.notion.com/v1"
const NOTION_VERSION = "2026-03-11"

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
  children?: NotionBlock[]
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

type NotionTokenRefreshHandler = (tokens: {
  accessToken: string
  refreshToken: string | null
}) => Promise<void>

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

export async function refreshNotionOAuthToken(input: {
  env: Env
  refreshToken: string
}): Promise<Pick<NotionTokenResponse, "access_token" | "refresh_token">> {
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
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  })
  if (!res.ok) {
    throw new Error(`Notion OAuth token refresh failed (${res.status})`)
  }
  return (await res.json()) as Pick<
    NotionTokenResponse,
    "access_token" | "refresh_token"
  >
}

async function fetchNotion<T>(
  input: {
    env: Env
    connection: NotionConnection
    onTokenRefresh?: NotionTokenRefreshHandler
  },
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!input.connection.accessToken) {
    throw new Error("Notion connection has no access token")
  }
  const request = (accessToken: string) =>
    fetch(`${NOTION_API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "notion-version": NOTION_VERSION,
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    })
  let res: Response
  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await request(input.connection.accessToken)
    } catch (error) {
      if (attempt >= 2) throw error
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
      continue
    }
    const transient = res.status === 429 || res.status >= 500
    if (!transient || attempt >= 2) break
    const retryAfter = Number(res.headers.get("retry-after"))
    const delayMs = Number.isFinite(retryAfter)
      ? Math.max(250, retryAfter * 1000)
      : 250 * 2 ** attempt
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  if (res.status === 401 && input.connection.refreshToken) {
    const tokens = await refreshNotionOAuthToken({
      env: input.env,
      refreshToken: input.connection.refreshToken,
    })
    input.connection.accessToken = tokens.access_token
    input.connection.refreshToken =
      tokens.refresh_token ?? input.connection.refreshToken
    await input.onTokenRefresh?.({
      accessToken: input.connection.accessToken,
      refreshToken: input.connection.refreshToken,
    })
    res = await request(input.connection.accessToken)
  }
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
  env: Env
  connection: NotionConnection
  query?: string
  onTokenRefresh?: NotionTokenRefreshHandler
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
        object: "page" | "database" | "data_source"
        id: string
        url?: string
        parent?: NotionParent
        properties?: Record<string, unknown>
        title?: unknown
      }>
      next_cursor?: string | null
      has_more?: boolean
    }>(
      {
        env: input.env,
        connection: input.connection,
        onTokenRefresh: input.onTokenRefresh,
      },
      "/search",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    )
    for (const result of data.results) {
      if (
        result.object !== "page" &&
        result.object !== "database" &&
        result.object !== "data_source"
      ) {
        continue
      }
      const type = result.object === "page" ? "page" : "database"
      items.push({
        id: result.id,
        type,
        title:
          type === "page"
            ? pageTitle(result.properties)
            : databaseTitle(result.title),
        url: result.url ?? null,
        parentExternalId: parentExternalId(result.parent),
      })
    }
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined
  } while (cursor)

  return items
}

export async function retrieveNotionPage(input: {
  env: Env
  connection: NotionConnection
  pageId: string
  onTokenRefresh?: NotionTokenRefreshHandler
}): Promise<NotionPage> {
  return fetchNotion<NotionPage>(
    {
      env: input.env,
      connection: input.connection,
      onTokenRefresh: input.onTokenRefresh,
    },
    `/pages/${encodeURIComponent(input.pageId)}`,
  )
}

export async function listNotionBlockChildren(input: {
  env: Env
  connection: NotionConnection
  blockId: string
  onTokenRefresh?: NotionTokenRefreshHandler
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
      {
        env: input.env,
        connection: input.connection,
        onTokenRefresh: input.onTokenRefresh,
      },
      `/blocks/${encodeURIComponent(input.blockId)}/children?${params.toString()}`,
    )
    blocks.push(...data.results)
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined
  } while (cursor)
  return blocks
}

export async function queryNotionDatabase(input: {
  env: Env
  connection: NotionConnection
  databaseId: string
  onTokenRefresh?: NotionTokenRefreshHandler
}): Promise<NotionPage[]> {
  const pages: NotionPage[] = []
  let cursor: string | undefined
  do {
    const body: Record<string, unknown> = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    const data = await fetchNotion<{
      results: NotionPage[]
      next_cursor?: string | null
      has_more?: boolean
    }>(
      {
        env: input.env,
        connection: input.connection,
        onTokenRefresh: input.onTokenRefresh,
      },
      `/data_sources/${encodeURIComponent(input.databaseId)}/query`,
      { method: "POST", body: JSON.stringify(body) },
    )
    pages.push(...data.results)
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined
  } while (cursor)
  return pages
}

export function getNotionPageTitle(page: NotionPage): string {
  return pageTitle(page.properties)
}
