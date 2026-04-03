import { resolveAtlassianConfluenceApiBaseUrl } from "../../lib/atlassian-api-base-url.js"

export type ConfluenceClientInput = {
  cloudId: string
  atlassianApiBaseUrl: string | null
  appSystemToken: string
}

export type ConfluenceSpace = {
  id: string
  key: string
  name: string
}

export type ConfluencePage = {
  id: string
  title: string
  spaceId: string
}

export type ConfluencePageWithBody = ConfluencePage & {
  bodyStorage: string
}

async function fetchConfluence<T>(
  input: ConfluenceClientInput,
  path: string,
): Promise<T> {
  const base = resolveAtlassianConfluenceApiBaseUrl(input)
  const response = await fetch(`${base}${path}`, {
    headers: {
      authorization: `Bearer ${input.appSystemToken}`,
      accept: "application/json",
    },
  })
  if (!response.ok) {
    throw new Error(`Confluence API request failed (${response.status})`)
  }
  return (await response.json()) as T
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
      results: Array<{ id: string; key: string; name: string }>
      _links?: { next?: string }
    }>(input, `/wiki/api/v2/spaces?${params.toString()}`)
    items.push(
      ...(data.results ?? []).map((space) => ({
        id: space.id,
        key: space.key,
        name: space.name,
      })),
    )
    const next = data._links?.next
    if (!next) break
    cursor = new URL(next, "https://dummy.invalid").searchParams.get("cursor") ?? undefined
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
      results: Array<{ id: string; title: string; spaceId?: string }>
      _links?: { next?: string }
    }>(input.client, `/wiki/api/v2/pages?${params.toString()}`)
    pages.push(
      ...(data.results ?? []).map((page) => ({
        id: page.id,
        title: page.title,
        spaceId: page.spaceId ?? input.spaceId,
      })),
    )
    const next = data._links?.next
    if (!next) break
    cursor = new URL(next, "https://dummy.invalid").searchParams.get("cursor") ?? undefined
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
    body?: { storage?: { value?: string } }
  }>(
    input.client,
    `/wiki/api/v2/pages/${encodeURIComponent(input.pageId)}?body-format=storage`,
  )
  return {
    id: data.id,
    title: data.title,
    spaceId: data.spaceId ?? "",
    bodyStorage: data.body?.storage?.value ?? "",
  }
}
