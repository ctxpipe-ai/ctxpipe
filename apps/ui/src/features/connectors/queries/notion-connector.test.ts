import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fetchNotionOAuthStart,
  NotionOAuthNotConfiguredError,
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

    await expect(
      fetchNotionOAuthStart("acme", "con_notion"),
    ).rejects.toBeInstanceOf(NotionOAuthNotConfiguredError)
    expect(fetch).toHaveBeenCalledWith(
      "/acme/api/v1/connectors/notion/oauth/start?connectionId=con_notion",
      expect.objectContaining({ credentials: "include" }),
    )
  })

  it("includes connectionId on OAuth start", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
        }),
        { status: 200 },
      ),
    )

    await fetchNotionOAuthStart("acme", "con_notion")

    expect(fetch).toHaveBeenCalledWith(
      "/acme/api/v1/connectors/notion/oauth/start?connectionId=con_notion",
      expect.objectContaining({ credentials: "include" }),
    )
  })
})
