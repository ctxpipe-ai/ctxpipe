import { resolveAtlassianConfluenceApiBaseUrl } from "../../lib/atlassian-api-base-url.js"
import {
  type ConnectorAssetBudget,
  type ConnectorAssetDownloadResult,
  downloadConnectorAsset,
} from "../connectors/assets.js"

export type ConfluenceClientInput = {
  cloudId: string
  atlassianApiBaseUrl: string | null
  appSystemToken: string
}

export type ConfluenceSpace = {
  id: string
  key: string
  name: string
  /** Space overview page; children under it are “top-level” in the UI and should not get an extra path segment. */
  homepageId: string | null
}

export type ConfluencePage = {
  id: string
  title: string
  spaceId: string
  /** Parent page id when the parent is a page in this space; null at space root. */
  parentId: string | null
}

export type ConfluencePageWithBody = ConfluencePage & {
  bodyStorage: string
}

export type ConfluenceAttachment = {
  id: string
  title: string
  fileSize: number | null
  mediaType: string | null
}

const CONFLUENCE_FETCH_MAX_ATTEMPTS = 4

function confluenceRetryDelayMs(attempt: number, response: Response): number {
  const ra = response.headers.get("Retry-After")
  if (ra) {
    const seconds = Number(ra)
    if (!Number.isNaN(seconds)) return Math.min(60_000, seconds * 1000)
  }
  return Math.min(10_000, 250 * 2 ** attempt)
}

function shouldRetryConfluenceStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

async function fetchConfluence<T>(
  input: ConfluenceClientInput,
  path: string,
  options?: {
    signal?: AbortSignal
    onResponse?: (response: Response) => void
  },
): Promise<T> {
  const base = resolveAtlassianConfluenceApiBaseUrl(input)
  for (let attempt = 0; attempt < CONFLUENCE_FETCH_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${base}${path}`, {
      headers: {
        authorization: `Bearer ${input.appSystemToken}`,
        accept: "application/json",
      },
      signal: options?.signal,
    })
    if (response.ok) {
      options?.onResponse?.(response)
      return (await response.json()) as T
    }
    if (
      shouldRetryConfluenceStatus(response.status) &&
      attempt < CONFLUENCE_FETCH_MAX_ATTEMPTS - 1
    ) {
      const delay = confluenceRetryDelayMs(attempt, response)
      await new Promise<void>((resolve, reject) => {
        const signal = options?.signal
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("Request aborted"))
          return
        }
        const onAbort = () => {
          clearTimeout(timeout)
          reject(signal?.reason ?? new Error("Request aborted"))
        }
        const timeout = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort)
          resolve()
        }, delay)
        signal?.addEventListener("abort", onAbort, { once: true })
      })
      continue
    }
    const text = await response.text().catch(() => "")
    const detail = text ? `: ${text.slice(0, 200)}` : ""
    throw new Error(
      `Confluence API request failed (${response.status})${detail}`,
    )
  }
  throw new Error("Confluence API request failed after retries")
}

export async function listConfluenceSpaces(
  input: ConfluenceClientInput,
): Promise<ConfluenceSpace[]> {
  const items: ConfluenceSpace[] = []
  let cursor: string | undefined
  while (true) {
    const params = new URLSearchParams({ limit: "250" })
    if (cursor) params.set("cursor", cursor)
    const data = await fetchConfluence<{
      results: Array<{
        id: string
        key: string
        name: string
        homepageId?: string
      }>
      _links?: { next?: string }
    }>(input, `/wiki/api/v2/spaces?${params.toString()}`)
    items.push(
      ...(data.results ?? []).map((space) => ({
        id: space.id,
        key: space.key,
        name: space.name,
        // Confluence Cloud has returned homepageId as the string "0" for spaces without a homepage
        // instead of omitting it or using null (see https://jira.atlassian.com/browse/CONFCLOUD-78159 ).
        // Space schema: https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/#api-spaces-get
        homepageId:
          space.homepageId && space.homepageId !== "0"
            ? space.homepageId
            : null,
      })),
    )
    const next = data._links?.next
    if (!next) break
    cursor =
      new URL(next, "https://dummy.invalid").searchParams.get("cursor") ??
      undefined
    if (!cursor) break
  }
  return items
}

export async function listConfluencePagesForSpace(input: {
  client: ConfluenceClientInput
  spaceId: string
}): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = []
  let cursor: string | undefined
  while (true) {
    const params = new URLSearchParams({
      spaceId: input.spaceId,
      limit: "200",
      status: "current",
    })
    if (cursor) params.set("cursor", cursor)
    const data = await fetchConfluence<{
      results: Array<{
        id: string
        title: string
        spaceId?: string
        parentId?: string
      }>
      _links?: { next?: string }
    }>(input.client, `/wiki/api/v2/pages?${params.toString()}`)
    pages.push(
      ...(data.results ?? []).map((page) => ({
        id: page.id,
        title: page.title,
        spaceId: page.spaceId ?? input.spaceId,
        parentId: page.parentId ?? null,
      })),
    )
    const next = data._links?.next
    if (!next) break
    cursor =
      new URL(next, "https://dummy.invalid").searchParams.get("cursor") ??
      undefined
    if (!cursor) break
  }
  return pages
}

export async function getConfluencePageWithBody(input: {
  client: ConfluenceClientInput
  pageId: string
}): Promise<ConfluencePageWithBody> {
  const data = await fetchConfluence<{
    id: string
    title: string
    spaceId?: string
    parentId?: string
    body?: { storage?: { value?: string } }
  }>(
    input.client,
    `/wiki/api/v2/pages/${encodeURIComponent(input.pageId)}?body-format=storage`,
  )
  return {
    id: data.id,
    title: data.title,
    spaceId: data.spaceId ?? "",
    parentId: data.parentId ?? null,
    bodyStorage: data.body?.storage?.value ?? "",
  }
}

function nextCursorFromLinks(next: string | undefined): string | undefined {
  if (!next) return undefined
  return (
    new URL(next, "https://dummy.invalid").searchParams.get("cursor") ??
    undefined
  )
}

function nextCursorFromLinkHeader(link: string | null): string | undefined {
  const next = link?.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i)?.[1]
  return nextCursorFromLinks(next)
}

export async function listConfluencePageAttachments(input: {
  client: ConfluenceClientInput
  pageId: string
  maxAttachments?: number
  signal?: AbortSignal
}): Promise<ConfluenceAttachment[]> {
  const attachments: ConfluenceAttachment[] = []
  const maxAttachments = Math.max(
    1,
    Math.floor(input.maxAttachments ?? Number.POSITIVE_INFINITY),
  )
  let cursor: string | undefined
  while (attachments.length < maxAttachments) {
    const params = new URLSearchParams({
      limit: String(Math.min(250, maxAttachments - attachments.length)),
    })
    if (cursor) params.set("cursor", cursor)
    let headerCursor: string | undefined
    const data = await fetchConfluence<{
      results: Array<{
        id?: string
        title?: string
        fileSize?: number
        mediaType?: string
      }>
      _links?: { next?: string }
    }>(
      input.client,
      `/wiki/api/v2/pages/${encodeURIComponent(input.pageId)}/attachments?${params.toString()}`,
      {
        signal: input.signal,
        onResponse: (response) => {
          headerCursor = nextCursorFromLinkHeader(response.headers.get("Link"))
        },
      },
    )
    for (const attachment of data.results ?? []) {
      if (!attachment.id || !attachment.title) {
        continue
      }
      attachments.push({
        id: attachment.id,
        title: attachment.title,
        fileSize:
          typeof attachment.fileSize === "number" ? attachment.fileSize : null,
        mediaType: attachment.mediaType ?? null,
      })
      if (attachments.length >= maxAttachments) break
    }
    cursor = nextCursorFromLinks(data._links?.next) ?? headerCursor
    if (!cursor) break
  }
  return attachments
}

export async function downloadConfluenceAttachment(input: {
  client: ConfluenceClientInput
  pageId: string
  attachmentId: string
  filename: string
  budget: ConnectorAssetBudget
}): Promise<ConnectorAssetDownloadResult> {
  const apiBase = resolveAtlassianConfluenceApiBaseUrl(input.client)
  return downloadConnectorAsset({
    url: `${apiBase}/wiki/rest/api/content/${encodeURIComponent(input.pageId)}/child/attachment/${encodeURIComponent(input.attachmentId)}/download`,
    budget: input.budget,
    filename: input.filename,
    headers: { authorization: `Bearer ${input.client.appSystemToken}` },
    authenticatedHosts: [new URL(apiBase).hostname],
  })
}
