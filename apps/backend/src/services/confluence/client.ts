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

export type ConfluenceClientConfig =
  | {
      authType: "basic"
      baseUrl: string
      email: string
      apiToken: string
    }
  | {
      authType: "oauth"
      /** Confluence API base — e.g. https://api.atlassian.com/ex/confluence/{cloudId} (Cloud)
       *  or https://confluence.company.com (DC) */
      apiBaseUrl: string
      refreshToken: string
      clientId: string
      clientSecret: string
      /** Token endpoint — Atlassian Cloud or DC instance URL */
      tokenUrl: string
    }

export class ConfluenceClient {
  private config: ConfluenceClientConfig
  private cachedAccessToken: string | null = null
  private cachedTokenExpiry = 0

  constructor(config: ConfluenceClientConfig) {
    this.config = config
  }

  private get apiBaseUrl(): string {
    return this.config.authType === "basic"
      ? this.config.baseUrl.replace(/\/$/, "")
      : this.config.apiBaseUrl.replace(/\/$/, "")
  }

  private async getAuthHeader(): Promise<string> {
    if (this.config.authType === "basic") {
      const creds = Buffer.from(
        `${this.config.email}:${this.config.apiToken}`,
      ).toString("base64")
      return `Basic ${creds}`
    }
    // OAuth — refresh access token if missing or expiring within 60s
    if (!this.cachedAccessToken || Date.now() >= this.cachedTokenExpiry - 60_000) {
      await this.refreshAccessToken()
    }
    return `Bearer ${this.cachedAccessToken}`
  }

  private async refreshAccessToken(): Promise<void> {
    if (this.config.authType !== "oauth") return
    const res = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Confluence token refresh failed: ${res.status} - ${err}`)
    }
    const data = (await res.json()) as { access_token: string; expires_in: number }
    this.cachedAccessToken = data.access_token
    this.cachedTokenExpiry = Date.now() + data.expires_in * 1000
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/wiki/api/v2${endpoint}`
    const authHeader = await this.getAuthHeader()
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: authHeader,
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

  private async requestV1<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/wiki/rest/api${endpoint}`
    const authHeader = await this.getAuthHeader()
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: authHeader,
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
    }>(`/spaces?keys=${encodeURIComponent(spaceKey)}&limit=250`)

    const returnedKeys = data.results.map((r) => r.key)

    // Find by key — defensive against the API ignoring the filter and returning all spaces
    const match = data.results.find((r) => r.key === spaceKey)
    if (!match) {
      throw new Error(
        `Space not found: ${spaceKey}. API returned keys: [${returnedKeys.join(", ")}]`,
      )
    }

    return ConfluenceSpaceSchema.parse(match)
  }

  async *getPagesInSpace(
    spaceId: string,
    options: { limit?: number; cursor?: string } = {},
  ): AsyncGenerator<ConfluencePage, void, unknown> {
    const limit = options.limit ?? 50
    let cursor = options.cursor

    while (true) {
      const params = new URLSearchParams({
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
      }>(`/spaces/${spaceId}/pages?${params.toString()}`)

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

      const nextUrl = new URL(data._links.next, "https://dummy.invalid")
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

      for (const space of data.results) {
        const parsed = ConfluenceSpaceSchema.safeParse(space)
        if (parsed.success) {
          allSpaces.push(parsed.data)
        } else {
          console.warn("[spaces] space failed schema validation:", JSON.stringify(parsed.error.issues))
        }
      }

      if (!data._links.next) break

      const nextUrl = new URL(data._links.next, "https://dummy.invalid")
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
    const url = `${this.apiBaseUrl}/wiki/rest/api/content/search?${params.toString()}`
    const authHeader = await this.getAuthHeader()
    const response = await fetch(url, {
      headers: {
        Authorization: authHeader,
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
