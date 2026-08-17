import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"
import type { NotionConnection } from "../../models/notion-connector.js"
import { listNotionBlockChildren, searchNotionResources } from "./client.js"

const env = {
  NOTION_CLIENT_ID: "client-id",
  NOTION_CLIENT_SECRET: "client-secret",
} as Env

const connection = {
  id: "con_1",
  accessToken: "expired",
  refreshToken: "refresh",
} as NotionConnection

describe("Notion API client", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it("refreshes an expired token and persists the rotated token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "fresh",
            refresh_token: "rotated-refresh",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [],
            has_more: false,
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)
    const onTokenRefresh = vi.fn().mockResolvedValue(undefined)

    await searchNotionResources({
      env,
      connection,
      onTokenRefresh,
    })

    expect(connection.accessToken).toBe("fresh")
    expect(connection.refreshToken).toBe("rotated-refresh")
    expect(onTokenRefresh).toHaveBeenCalledWith({
      accessToken: "fresh",
      refreshToken: "rotated-refresh",
    })
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.notion.com/v1/search",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer fresh",
          "notion-version": "2026-03-11",
        }),
      }),
    )
  })

  it("follows all resource pages instead of truncating the result set", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                object: "page",
                id: "page-1",
                properties: {
                  Name: { type: "title", title: [{ plain_text: "One" }] },
                },
              },
            ],
            has_more: true,
            next_cursor: "next",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                object: "data_source",
                id: "db-1",
                title: [{ plain_text: "Two" }],
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    await expect(searchNotionResources({ env, connection })).resolves.toEqual([
      expect.objectContaining({ id: "page-1", title: "One" }),
      expect.objectContaining({ id: "db-1", title: "Two" }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("paginates block children", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: "b-1", type: "paragraph" }],
            has_more: true,
            next_cursor: "next",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: "b-2", type: "divider" }],
            has_more: false,
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      listNotionBlockChildren({ env, connection, blockId: "page-1" }),
    ).resolves.toHaveLength(2)
  })
})
