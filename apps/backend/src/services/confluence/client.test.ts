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
        downloadLink: "/wiki/download/attachments/42/diagram.png?version=1",
      },
      {
        id: "att200",
        title: "spec.pdf",
        fileSize: 4096,
        mediaType: "application/pdf",
        downloadLink: "/wiki/download/attachments/42/spec.pdf",
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
        downloadLink: "/wiki/download/attachments/42/diagram.png",
        filename: "diagram.png",
        budget: createConnectorAssetBudget(),
      }),
    ).resolves.toMatchObject({ status: "downloaded", filename: "diagram.png" })

    expect(downloadConnectorAsset).toHaveBeenCalledWith({
      url: "https://api.atlassian.com/ex/confluence/cloud-1/wiki/download/attachments/42/diagram.png",
      budget: expect.any(Object),
      filename: "diagram.png",
      headers: { authorization: "Bearer forge-app-token" },
      authenticatedHosts: ["api.atlassian.com"],
    })
  })

  it("joins a relative downloadLink onto the Atlassian gateway base", async () => {
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
      downloadLink: "/wiki/download/attachments/42/diagram.png",
      filename: "diagram.png",
      budget: createConnectorAssetBudget(),
    })

    expect(downloadConnectorAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.atlassian.com/ex/confluence/cloud-1/wiki/download/attachments/42/diagram.png",
      }),
    )
  })
})
