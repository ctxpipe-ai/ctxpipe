import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fetchNotionOAuthStart,
  NotionOAuthNotConfiguredError,
  retryNotionConfig,
  retryNotionSync,
} from "./notion-connector"

describe("Notion connector API helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("raises a configuration error for an unconfigured deployment", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "notion_oauth_not_configured",
          error: "Notion OAuth is not configured for this ctxpipe deployment.",
        }),
        { status: 503 },
      ),
    )

    await expect(fetchNotionOAuthStart("acme")).rejects.toBeInstanceOf(
      NotionOAuthNotConfiguredError,
    )
  })

  it("posts a content sync retry for the selected connection", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))

    await retryNotionSync("acme", "con_notion")

    expect(fetch).toHaveBeenCalledWith(
      "/acme/api/v1/connectors/notion/retry?connectionId=con_notion",
      { method: "POST", credentials: "include" },
    )
  })

  it("submits resources when retrying configuration creation", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))
    const resources = [
      {
        externalId: "page-1",
        type: "page" as const,
        title: "Handbook",
      },
    ]

    await retryNotionConfig("acme", "con_notion", resources)

    expect(fetch).toHaveBeenCalledWith(
      "/acme/api/v1/connectors/notion/retry-config?connectionId=con_notion",
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resources }),
      },
    )
  })
})
