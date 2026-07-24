import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fetchNotionOAuthStart,
  NotionOAuthNotConfiguredError,
} from "./notion-connector"

describe("Notion OAuth API helpers", () => {
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
})
