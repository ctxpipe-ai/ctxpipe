import { z } from "zod"

const ConfluencePageSchema = z.object({
  id: z.string(),
  status: z.string(),
  title: z.string(),
  spaceId: z.string(),
  parentId: z.string().optional(),
  version: z.object({
    number: z.number(),
    createdAt: z.string(),
  }),
  body: z.object({
    storage: z.object({
      value: z.string(),
      representation: z.string(),
    }),
  }),
})

const ConfluenceSpaceSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  type: z.string(),
  // homepageId is the root page of the space; its children are the "top-level" content pages
  homepageId: z.string().optional(),
})

const ConfluencePageSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  // spaceId may be absent in /pages/{id}/children responses; make optional
  // to prevent safeParse from silently dropping valid child pages
  spaceId: z.string().optional(),
  parentId: z.string().optional(),
  childrenCount: z.number().optional(),
})

export type ConfluencePage = z.infer<typeof ConfluencePageSchema>
export type ConfluenceSpace = z.infer<typeof ConfluenceSpaceSchema>
export type ConfluencePageSummary = z.infer<typeof ConfluencePageSummarySchema>

export interface ConfluenceClientConfig {
  baseUrl: string
  apiToken: string
  email: string
}

export class ConfluenceClient {
  private baseUrl: string
  private apiToken: string
  private email: string

  constructor(config: ConfluenceClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "")
    this.apiToken = config.apiToken
    this.email = config.email
  }

  private getAuthHeader(): string {
    const credentials = Buffer.from(`${this.email}:${this.apiToken}`).toString(
      "base64",
    )
    return `Basic ${credentials}`
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}/wiki/api/v2${endpoint}`
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.getAuthHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(
        `Confluence API error: ${response.status} ${response.statusText} - ${error}`,
      )
    }

    return response.json() as Promise<T>
  }

  async getSpace(spaceKey: string): Promise<ConfluenceSpace> {
    const data = await this.request<{
      results: Array<{
        id: string
        key: string
        name: string
        type: string
        homepageId?: string
      }>
    }>(`/spaces?keys=${encodeURIComponent(spaceKey)}`)

    if (!data.results.length) {
      throw new Error(`Space not found: ${spaceKey}`)
    }

    return ConfluenceSpaceSchema.parse(data.results[0])
  }

  async *getPagesInSpace(
    spaceId: string,
    options: { limit?: number; cursor?: string } = {},
  ): AsyncGenerator<ConfluencePage, void, unknown> {
    const limit = options.limit ?? 50
    let cursor = options.cursor

    while (true) {
      const params = new URLSearchParams({
        spaceId,
        limit: limit.toString(),
        status: "current",
        "body-format": "storage",
      })

      if (cursor) {
        params.append("cursor", cursor)
      }

      const data = await this.request<{
        results: unknown[]
        _links: {
          next?: string
        }
      }>(`/pages?${params.toString()}`)

      for (const page of data.results) {
        const parsed = ConfluencePageSchema.safeParse(page)
        if (parsed.success) {
          yield parsed.data
        } else {
          console.warn("Confluence page failed schema validation:", JSON.stringify(parsed.error.issues))
        }
      }

      if (!data._links.next) {
        break
      }

      const nextUrl = new URL(data._links.next, this.baseUrl)
      cursor = nextUrl.searchParams.get("cursor") ?? undefined
      if (!cursor) break
    }
  }

  async getPage(pageId: string): Promise<ConfluencePage> {
    const data = await this.request<unknown>(
      `/pages/${pageId}?body-format=storage`,
    )
    return ConfluencePageSchema.parse(data)
  }

  async getChildPages(pageId: string): Promise<ConfluencePage[]> {
    const data = await this.request<{
      results: unknown[]
    }>(`/pages/${pageId}/children`)

    return data.results
      .map((page) => ConfluencePageSchema.safeParse(page))
      .filter(
        (result): result is { success: true; data: ConfluencePage } =>
          result.success,
      )
      .map((result) => result.data)
  }

  async listSpaces(limit = 250): Promise<ConfluenceSpace[]> {
    const allSpaces: ConfluenceSpace[] = []
    let cursor: string | undefined
    let page = 0

    while (true) {
      page++
      const params = new URLSearchParams({ limit: limit.toString() })
      if (cursor) params.append("cursor", cursor)

      const data = await this.request<{
        results: unknown[]
        _links: { next?: string }
      }>(`/spaces?${params.toString()}`)

      console.log(`[spaces] page ${page}: API returned ${data.results.length} raw results, hasNext=${!!data._links.next}`)

      for (const space of data.results) {
        const parsed = ConfluenceSpaceSchema.safeParse(space)
        if (parsed.success) {
          allSpaces.push(parsed.data)
        } else {
          console.warn("[spaces] space failed schema validation:", JSON.stringify(parsed.error.issues))
        }
      }

      if (!data._links.next) break

      const nextUrl = new URL(data._links.next, this.baseUrl)
      cursor = nextUrl.searchParams.get("cursor") ?? undefined
      if (!cursor) break
    }

    return allSpaces
  }

  /**
   * Returns the pages that should appear at the top level when browsing a space.
   *
   * Confluence Cloud's `depth=root` only returns the single space homepage,
   * which is not useful for navigation. Instead, we fetch the children of
   * the homepage so users see the real top-level content sections.
   * Falls back to depth=root if no homepageId is available.
   */
  async getTopLevelPages(
    spaceId: string,
    homepageId?: string,
  ): Promise<ConfluencePageSummary[]> {
    if (homepageId) {
      return this.getChildPageSummaries(homepageId)
    }

    // Fallback: depth=root (returns the homepage itself)
    const params = new URLSearchParams({
      spaceId,
      depth: "root",
      limit: "100",
      status: "current",
    })
    const data = await this.request<{ results: unknown[] }>(
      `/pages?${params.toString()}`,
    )
    const pages: ConfluencePageSummary[] = []
    for (const page of data.results) {
      const parsed = ConfluencePageSummarySchema.safeParse(page)
      if (parsed.success) {
        pages.push(parsed.data)
      } else {
        console.warn("[confluence] root page failed schema parse:", parsed.error.issues, page)
      }
    }
    return pages
  }

  async getChildPageSummaries(
    pageId: string,
  ): Promise<ConfluencePageSummary[]> {
    const data = await this.request<{ results: unknown[] }>(
      `/pages/${pageId}/children?limit=100`,
    )

    const pages: ConfluencePageSummary[] = []
    for (const page of data.results) {
      const parsed = ConfluencePageSummarySchema.safeParse(page)
      if (parsed.success) {
        pages.push(parsed.data)
      } else {
        console.warn("[confluence] child page failed schema parse:", parsed.error.issues, page)
      }
    }
    return pages
  }

  /**
   * Search pages within a space by title using CQL (Confluence Query Language).
   * Uses the v1 REST API which supports full-text CQL search.
   */
  async searchPages(
    spaceKey: string,
    query: string,
    limit = 25,
  ): Promise<ConfluencePageSummary[]> {
    // Use wildcard ~"*term*" instead of plain ~"term" so Confluence does a
    // term-level wildcard search rather than full-text analysis. Full-text
    // analysis strips punctuation (e.g. "&") which breaks queries like "R&D".
    const safe = query.replace(/"/g, "").replace(/\*/g, "").trim()
    const cql = `type=page AND space.key="${spaceKey}" AND title ~ "*${safe}*"`
    const params = new URLSearchParams({
      cql,
      limit: limit.toString(),
      expand: "space",
    })
    const url = `${this.baseUrl}/wiki/rest/api/content/search?${params.toString()}`
    const response = await fetch(url, {
      headers: {
        Authorization: this.getAuthHeader(),
        Accept: "application/json",
      },
    })
    if (!response.ok) {
      const error = await response.text()
      throw new Error(
        `Confluence search error: ${response.status} ${response.statusText} - ${error}`,
      )
    }
    const data = (await response.json()) as {
      results: Array<{ id: string; title: string; space?: { id: string } }>
    }
    return data.results.map((r) => ({
      id: r.id,
      title: r.title,
      spaceId: r.space?.id ?? "",
    }))
  }
}
