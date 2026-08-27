import { afterEach, describe, expect, it, vi } from "vitest"
import { createConnectorAssetBudget } from "../connectors/assets.js"

const downloadConnectorAsset = vi.hoisted(() => vi.fn())

vi.mock("../connectors/assets.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../connectors/assets.js")>()
  return { ...actual, downloadConnectorAsset }
})

import {
  downloadConfluenceAttachment,
  listConfluencePageAttachments,
} from "./client.js"

const client = {
  cloudId: "cloud-1",
  atlassianApiBaseUrl: "https://api.atlassian.com/ex/confluence/cloud-1",
  appSystemToken: "forge-app-token",
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("listConfluencePageAttachments", () => {
  it("paginates attachment metadata from the Confluence v2 API", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                id: "att100",
                title: "diagram.png",
                fileSize: 2048,
                mediaType: "image/png",
                downloadLink:
                  "/wiki/download/attachments/42/diagram.png?version=1",
              },
            ],
            _links: {
              next: "/wiki/api/v2/pages/42/attachments?cursor=page-2",
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                id: "att200",
                title: "spec.pdf",
                fileSize: 4096,
                mediaType: "application/pdf",
                downloadLink: "/wiki/download/attachments/42/spec.pdf",
              },
            ],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      listConfluencePageAttachments({ client, pageId: "42" }),
    ).resolves.toEqual([
      {
        id: "att100",
        title: "diagram.png",
        fileSize: 2048,
        mediaType: "image/png",
      },
      {
        id: "att200",
        title: "spec.pdf",
        fileSize: 4096,
        mediaType: "application/pdf",
      },
    ])

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/wiki/api/v2/pages/42/attachments?",
    )
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=page-2")
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer forge-app-token",
        }),
      }),
    )
  })

  it("follows attachment pagination from the Link response header", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: "att100", title: "diagram.png" }],
          }),
          {
            status: 200,
            headers: {
              Link: '</wiki/api/v2/pages/42/attachments?cursor=page-2>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: "att200", title: "spec.pdf" }],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      listConfluencePageAttachments({ client, pageId: "42" }),
    ).resolves.toEqual([
      {
        id: "att100",
        title: "diagram.png",
        fileSize: null,
        mediaType: null,
      },
      {
        id: "att200",
        title: "spec.pdf",
        fileSize: null,
        mediaType: null,
      },
    ])
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=page-2")
  })

  it("stops metadata discovery at the requested attachment cap", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { id: "att100", title: "one.png" },
            { id: "att200", title: "two.png" },
          ],
          _links: {
            next: "/wiki/api/v2/pages/42/attachments?cursor=page-2",
          },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      listConfluencePageAttachments({
        client,
        pageId: "42",
        maxAttachments: 1,
      }),
    ).resolves.toEqual([
      {
        id: "att100",
        title: "one.png",
        fileSize: null,
        mediaType: null,
      },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("downloadConfluenceAttachment", () => {
  it("downloads via the shared downloader with auth only on the product API host", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: Buffer.from("png-bytes"),
      filename: "diagram.png",
      contentType: "image/png",
    })

    await expect(
      downloadConfluenceAttachment({
        client,
        pageId: "42",
        attachmentId: "att100",
        filename: "diagram.png",
        budget: createConnectorAssetBudget(),
      }),
    ).resolves.toMatchObject({ status: "downloaded", filename: "diagram.png" })

    expect(downloadConnectorAsset).toHaveBeenCalledWith({
      url: "https://api.atlassian.com/ex/confluence/cloud-1/wiki/rest/api/content/42/child/attachment/att100/download",
      budget: expect.any(Object),
      filename: "diagram.png",
      headers: { authorization: "Bearer forge-app-token" },
      authenticatedHosts: ["api.atlassian.com"],
    })
  })

  it("uses the authenticated v1 attachment download endpoint", async () => {
    downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: Buffer.from("png-bytes"),
      filename: "diagram.png",
      contentType: "image/png",
    })

    await downloadConfluenceAttachment({
      client: {
        cloudId: "cloud-1",
        atlassianApiBaseUrl: null,
        appSystemToken: "forge-app-token",
      },
      pageId: "page/42",
      attachmentId: "attachment/100",
      filename: "diagram.png",
      budget: createConnectorAssetBudget(),
    })

    expect(downloadConnectorAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.atlassian.com/ex/confluence/cloud-1/wiki/rest/api/content/page%2F42/child/attachment/attachment%2F100/download",
      }),
    )
  })
})
