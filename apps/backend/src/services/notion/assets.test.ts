import { describe, expect, it, vi } from "vitest"
import { connectorAssetCommitFile, gitBlobSha } from "../connectors/assets.js"
import {
  buildNotionPageMirrorFiles,
  captureNotionEntityAssets,
  notionCommitFilesExcludingUnchanged,
} from "./assets.js"
import type { NotionBlock, NotionPage } from "./client.js"

const page: NotionPage = {
  id: "page-1",
  url: "https://www.notion.so/planning-page-1",
  properties: {
    Name: { type: "title", title: [{ plain_text: "Planning" }] },
  },
}

function downloaded(filename: string, body = "bytes") {
  return {
    status: "downloaded" as const,
    bytes: Buffer.from(body),
    filename,
    contentType: "application/octet-stream",
  }
}

describe("captureNotionEntityAssets", () => {
  it("fetches hosted Notion files immediately without a bearer token", async () => {
    const downloadAsset = vi.fn().mockResolvedValue(downloaded("diagram.png"))
    const hostedUrl =
      "https://prod-files-secure.s3.us-west-2.amazonaws.com/space/diagram.png?X-Amz-Signature=abc"

    const result = await captureNotionEntityAssets({
      markdownPath: "notion/pages/planning--page-1/index.md",
      page,
      blocks: [
        {
          id: "image-1",
          type: "image",
          image: {
            type: "file",
            name: "diagram.png",
            file: { url: hostedUrl },
            caption: [{ plain_text: "Diagram" }],
          },
        },
      ],
      downloadAsset,
    })

    expect(downloadAsset).toHaveBeenCalledTimes(1)
    const call = downloadAsset.mock.calls[0]?.[0] as {
      url: string
      headers?: Record<string, string>
      authenticatedHosts?: string[]
    }
    expect(call.url).toBe(hostedUrl)
    expect(call.headers).toBeUndefined()
    expect(call.authenticatedHosts).toBeUndefined()
    expect(result.files).toEqual([
      connectorAssetCommitFile(
        "notion/pages/planning--page-1/assets/image-1--diagram.png",
        Buffer.from("bytes"),
      ),
    ])
    expect(result.assetMap.get("image-1")).toEqual({
      status: "ok",
      relativePath: "./assets/image-1--diagram.png",
      alt: "Diagram",
      kind: "image",
    })
  })

  it("downloads explicit external media through the shared downloader", async () => {
    const downloadAsset = vi.fn().mockResolvedValue(downloaded("photo.jpg"))

    const result = await captureNotionEntityAssets({
      markdownPath: "notion/pages/planning--page-1/index.md",
      page,
      blocks: [
        {
          id: "image-2",
          type: "image",
          image: {
            type: "external",
            external: { url: "https://images.example/photo.jpg" },
            caption: [{ plain_text: "Photo" }],
          },
        },
      ],
      downloadAsset,
    })

    expect(downloadAsset).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://images.example/photo.jpg" }),
    )
    expect(result.files[0]?.path).toBe(
      "notion/pages/planning--page-1/assets/image-2--photo.jpg",
    )
    expect(result.assetMap.get("image-2")).toMatchObject({
      status: "ok",
      relativePath: "./assets/image-2--photo.jpg",
      kind: "image",
    })
  })

  it("turns download failures and limits into permalink stubs without throwing", async () => {
    const downloadAsset = vi.fn().mockResolvedValue({
      status: "stub",
      reason: "asset_limit",
    })

    const result = await captureNotionEntityAssets({
      markdownPath: "notion/pages/planning--page-1/index.md",
      page,
      blocks: [
        {
          id: "file-1",
          type: "file",
          file: {
            type: "file",
            name: "huge.bin",
            file: {
              url: "https://prod-files-secure.s3.amazonaws.com/huge.bin",
            },
            caption: [{ plain_text: "Huge" }],
          },
        },
      ],
      downloadAsset,
    })

    expect(result.files).toEqual([])
    expect(result.assetMap.get("file-1")).toEqual({
      status: "stub",
      alt: "Huge",
      permalink: "https://www.notion.so/planning-page-1",
      kind: "file",
    })
  })

  it("captures cover, icon, nested media, and database files properties", async () => {
    const downloadAsset = vi.fn(async ({ filename }: { filename?: string }) =>
      downloaded(filename ?? "attachment.bin", filename ?? "attachment.bin"),
    )
    const nested: NotionBlock = {
      id: "toggle-1",
      type: "toggle",
      children: [
        {
          id: "pdf-1",
          type: "pdf",
          pdf: {
            type: "file",
            name: "brief.pdf",
            file: {
              url: "https://prod-files-secure.s3.amazonaws.com/brief.pdf",
            },
          },
        },
      ],
    }
    const row: NotionPage = {
      id: "row-1",
      url: "https://www.notion.so/row-1",
      cover: {
        type: "external",
        external: { url: "https://images.example/banner.png" },
      },
      icon: {
        type: "file",
        file: { url: "https://prod-files-secure.s3.amazonaws.com/logo.png" },
      },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Row" }] },
        Attachments: {
          type: "files",
          files: [
            {
              name: "spec.pdf",
              type: "file",
              file: {
                url: "https://prod-files-secure.s3.amazonaws.com/spec.pdf",
              },
            },
            {
              name: "shot.png",
              type: "external",
              external: { url: "https://images.example/shot.png" },
            },
          ],
        },
      },
    }

    const result = await captureNotionEntityAssets({
      markdownPath: "notion/databases/tasks--db-1/rows/row--row-1/index.md",
      page: row,
      blocks: [nested],
      downloadAsset,
    })

    expect(downloadAsset).toHaveBeenCalledTimes(5)
    expect(result.files.map((file) => file.path)).toEqual([
      "notion/databases/tasks--db-1/rows/row--row-1/assets/cover--banner.png",
      "notion/databases/tasks--db-1/rows/row--row-1/assets/icon--logo.png",
      "notion/databases/tasks--db-1/rows/row--row-1/assets/attachments--spec.pdf",
      "notion/databases/tasks--db-1/rows/row--row-1/assets/attachments--shot.png",
      "notion/databases/tasks--db-1/rows/row--row-1/assets/pdf-1--brief.pdf",
    ])
    expect(result.assetMap.get("cover")?.status).toBe("ok")
    expect(result.assetMap.get("icon")?.status).toBe("ok")
    expect(result.assetMap.get("files:Attachments:spec.pdf")?.status).toBe("ok")
    expect(result.assetMap.get("files:Attachments:shot.png")?.status).toBe("ok")
    expect(result.assetMap.get("pdf-1")).toMatchObject({
      status: "ok",
      kind: "file",
      relativePath: "./assets/pdf-1--brief.pdf",
    })
  })

  it("keeps files-property asset paths when uniquely named files are reordered", async () => {
    const downloadAsset = vi.fn(async ({ filename }: { filename?: string }) =>
      downloaded(filename ?? "attachment.bin"),
    )
    const spec = {
      name: "spec.pdf",
      type: "file",
      file: { url: "https://prod-files-secure.s3.amazonaws.com/spec.pdf" },
    }
    const shot = {
      name: "shot.png",
      type: "external",
      external: { url: "https://images.example/shot.png" },
    }
    const capture = (files: unknown[]) =>
      captureNotionEntityAssets({
        markdownPath: "notion/databases/tasks--db-1/rows/row--row-1/index.md",
        page: {
          id: "row-1",
          url: "https://www.notion.so/row-1",
          properties: {
            Attachments: { id: "prop-att", type: "files", files },
          },
        },
        blocks: [],
        downloadAsset,
      })

    const first = await capture([spec, shot])
    const second = await capture([shot, spec])

    expect(first.files.map((file) => file.path).sort()).toEqual([
      "notion/databases/tasks--db-1/rows/row--row-1/assets/prop-att--shot.png",
      "notion/databases/tasks--db-1/rows/row--row-1/assets/prop-att--spec.pdf",
    ])
    expect(second.files.map((file) => file.path).sort()).toEqual(
      first.files.map((file) => file.path).sort(),
    )
    expect(first.assetMap.get("files:prop-att:spec.pdf")).toMatchObject({
      status: "ok",
      relativePath: "./assets/prop-att--spec.pdf",
    })
    expect(second.assetMap.get("files:prop-att:spec.pdf")).toMatchObject({
      status: "ok",
      relativePath: "./assets/prop-att--spec.pdf",
    })
  })

  it("keeps files-property asset paths when the property is renamed and the id is stable", async () => {
    const downloadAsset = vi.fn(async ({ filename }: { filename?: string }) =>
      downloaded(filename ?? "attachment.bin"),
    )
    const spec = {
      name: "spec.pdf",
      type: "file",
      file: { url: "https://prod-files-secure.s3.amazonaws.com/spec.pdf" },
    }
    const capture = (propertyName: string) =>
      captureNotionEntityAssets({
        markdownPath: "notion/databases/tasks--db-1/rows/row--row-1/index.md",
        page: {
          id: "row-1",
          url: "https://www.notion.so/row-1",
          properties: {
            [propertyName]: { id: "prop-att", type: "files", files: [spec] },
          },
        },
        blocks: [],
        downloadAsset,
      })

    const first = await capture("Attachments")
    const second = await capture("Evidence")

    expect(first.files.map((file) => file.path)).toEqual([
      "notion/databases/tasks--db-1/rows/row--row-1/assets/prop-att--spec.pdf",
    ])
    expect(second.files.map((file) => file.path)).toEqual(
      first.files.map((file) => file.path),
    )
    expect(first.assetMap.get("files:prop-att:spec.pdf")?.status).toBe("ok")
    expect(second.assetMap.get("files:prop-att:spec.pdf")?.status).toBe("ok")
  })

  it("suffixes duplicate files-property names and ignores signed file.url identity", async () => {
    const downloadAsset = vi.fn(async ({ filename }: { filename?: string }) =>
      downloaded(filename ?? "attachment.bin"),
    )
    const result = await captureNotionEntityAssets({
      markdownPath: "notion/databases/tasks--db-1/rows/row--row-1/index.md",
      page: {
        id: "row-1",
        url: "https://www.notion.so/row-1",
        properties: {
          Attachments: {
            id: "prop-att",
            type: "files",
            files: [
              {
                name: "spec.pdf",
                type: "file",
                file: {
                  url: "https://prod-files-secure.s3.amazonaws.com/a?X-Amz-Signature=one",
                },
              },
              {
                name: "spec.pdf",
                type: "file",
                file: {
                  url: "https://prod-files-secure.s3.amazonaws.com/b?X-Amz-Signature=two",
                },
              },
              {
                name: "pending.pdf",
                type: "file_upload",
                file_upload: { id: "fu-stable" },
              },
            ],
          },
        },
      },
      blocks: [],
      downloadAsset,
    })

    const sha = gitBlobSha(Buffer.from("bytes"))
    expect(result.files.map((file) => file.path)).toEqual([
      `notion/databases/tasks--db-1/rows/row--row-1/assets/prop-att--${sha}--spec.pdf`,
    ])
    expect(
      result.files.some((file) => file.path.includes("Amz-Signature")),
    ).toBe(false)
    expect(result.assetMap.get("files:prop-att:spec.pdf")).toMatchObject({
      status: "ok",
      relativePath: `./assets/prop-att--${sha}--spec.pdf`,
    })
    expect(result.assetMap.get("files:prop-att:spec-2.pdf")).toMatchObject({
      status: "ok",
      relativePath: `./assets/prop-att--${sha}--spec.pdf`,
    })
    expect(result.assetMap.get("files:prop-att:fu-stable")).toMatchObject({
      status: "stub",
      permalink: "https://www.notion.so/row-1",
    })
    expect(downloadAsset).toHaveBeenCalledTimes(2)
  })

  it("keeps duplicate-name files-property bytes on content-stable paths when reordered", async () => {
    const alpha = "alpha-bytes"
    const beta = "beta-bytes"
    const alphaSha = gitBlobSha(Buffer.from(alpha))
    const betaSha = gitBlobSha(Buffer.from(beta))
    const alphaUrl =
      "https://prod-files-secure.s3.amazonaws.com/a?X-Amz-Signature=one"
    const betaUrl =
      "https://prod-files-secure.s3.amazonaws.com/b?X-Amz-Signature=two"
    const downloadAsset = vi.fn(async ({ url }: { url: string }) => {
      if (url === alphaUrl) return downloaded("spec.pdf", alpha)
      if (url === betaUrl) return downloaded("spec.pdf", beta)
      throw new Error(`unexpected url ${url}`)
    })
    const spec = (url: string) => ({
      name: "spec.pdf",
      type: "file",
      file: { url },
    })
    const capture = (files: unknown[]) =>
      captureNotionEntityAssets({
        markdownPath: "notion/databases/tasks--db-1/rows/row--row-1/index.md",
        page: {
          id: "row-1",
          url: "https://www.notion.so/row-1",
          properties: {
            Attachments: { id: "prop-att", type: "files", files },
          },
        },
        blocks: [],
        downloadAsset,
      })

    const first = await capture([spec(alphaUrl), spec(betaUrl)])
    const second = await capture([spec(betaUrl), spec(alphaUrl)])
    const expectedPaths = [
      `notion/databases/tasks--db-1/rows/row--row-1/assets/prop-att--${alphaSha}--spec.pdf`,
      `notion/databases/tasks--db-1/rows/row--row-1/assets/prop-att--${betaSha}--spec.pdf`,
    ]

    expect(first.files.map((file) => file.path).sort()).toEqual(
      expectedPaths.sort(),
    )
    expect(second.files.map((file) => file.path).sort()).toEqual(
      expectedPaths.sort(),
    )
    expect(
      first.files.some((file) => file.path.includes("Amz-Signature")),
    ).toBe(false)
    expect(
      first.files.find((file) => file.path.includes(alphaSha))?.content,
    ).toBe(Buffer.from(alpha).toString("base64"))
    expect(
      second.files.find((file) => file.path.includes(alphaSha))?.content,
    ).toBe(Buffer.from(alpha).toString("base64"))
    expect(first.assetMap.get("files:prop-att:spec.pdf")).toMatchObject({
      status: "ok",
      relativePath: `./assets/prop-att--${alphaSha}--spec.pdf`,
    })
    expect(second.assetMap.get("files:prop-att:spec.pdf")).toMatchObject({
      status: "ok",
      relativePath: `./assets/prop-att--${betaSha}--spec.pdf`,
    })
  })

  it("deduplicates identical-byte files-property duplicates onto one content path", async () => {
    const body = "same-bytes"
    const sha = gitBlobSha(Buffer.from(body))
    const downloadAsset = vi.fn(async () => downloaded("spec.pdf", body))
    const result = await captureNotionEntityAssets({
      markdownPath: "notion/databases/tasks--db-1/rows/row--row-1/index.md",
      page: {
        id: "row-1",
        url: "https://www.notion.so/row-1",
        properties: {
          Attachments: {
            id: "prop-att",
            type: "files",
            files: [
              {
                name: "spec.pdf",
                type: "file",
                file: {
                  url: "https://prod-files-secure.s3.amazonaws.com/a?X-Amz-Signature=one",
                },
              },
              {
                name: "spec.pdf",
                type: "file",
                file: {
                  url: "https://prod-files-secure.s3.amazonaws.com/b?X-Amz-Signature=two",
                },
              },
            ],
          },
        },
      },
      blocks: [],
      downloadAsset,
    })

    expect(result.files.map((file) => file.path)).toEqual([
      `notion/databases/tasks--db-1/rows/row--row-1/assets/prop-att--${sha}--spec.pdf`,
    ])
    expect(result.assetMap.get("files:prop-att:spec.pdf")).toMatchObject({
      status: "ok",
      relativePath: `./assets/prop-att--${sha}--spec.pdf`,
    })
    expect(result.assetMap.get("files:prop-att:spec-2.pdf")).toMatchObject({
      status: "ok",
      relativePath: `./assets/prop-att--${sha}--spec.pdf`,
    })
  })

  it("stubs a failed files-property duplicate without a signed URL", async () => {
    const body = "alpha-bytes"
    const sha = gitBlobSha(Buffer.from(body))
    const okUrl =
      "https://prod-files-secure.s3.amazonaws.com/a?X-Amz-Signature=one"
    const failUrl =
      "https://prod-files-secure.s3.amazonaws.com/b?X-Amz-Signature=two"
    const downloadAsset = vi.fn(async ({ url }: { url: string }) => {
      if (url === okUrl) return downloaded("spec.pdf", body)
      return { status: "stub" as const, reason: "download_failed" as const }
    })
    const result = await captureNotionEntityAssets({
      markdownPath: "notion/databases/tasks--db-1/rows/row--row-1/index.md",
      page: {
        id: "row-1",
        url: "https://www.notion.so/row-1",
        properties: {
          Attachments: {
            id: "prop-att",
            type: "files",
            files: [
              { name: "spec.pdf", type: "file", file: { url: okUrl } },
              { name: "spec.pdf", type: "file", file: { url: failUrl } },
            ],
          },
        },
      },
      blocks: [],
      downloadAsset,
    })

    expect(result.files.map((file) => file.path)).toEqual([
      `notion/databases/tasks--db-1/rows/row--row-1/assets/prop-att--${sha}--spec.pdf`,
    ])
    expect(result.assetMap.get("files:prop-att:spec.pdf")).toMatchObject({
      status: "ok",
      relativePath: `./assets/prop-att--${sha}--spec.pdf`,
    })
    expect(result.assetMap.get("files:prop-att:spec-2.pdf")).toMatchObject({
      status: "stub",
      permalink: "https://www.notion.so/row-1",
    })
    expect(
      JSON.stringify(result.assetMap.get("files:prop-att:spec-2.pdf")),
    ).not.toContain("X-Amz-Signature")
  })

  it("stubs id-only file_upload objects and still captures output file.url", async () => {
    const uploadLifecycleUrl =
      "https://api.notion.com/v1/file_uploads/fu-1/send"
    const hostedUrl =
      "https://prod-files-secure.s3.us-west-2.amazonaws.com/space/diagram.png?X-Amz-Signature=abc"
    const downloadAsset = vi.fn().mockResolvedValue(downloaded("diagram.png"))

    const files = await buildNotionPageMirrorFiles({
      resource: { externalId: "page-1", title: "Planning" },
      page,
      blocks: [
        {
          id: "upload-1",
          type: "image",
          image: {
            type: "file_upload",
            file_upload: { id: "fu-1" },
            upload_url: uploadLifecycleUrl,
            caption: [{ plain_text: "Pending" }],
          },
        },
        {
          id: "image-1",
          type: "image",
          image: {
            type: "file",
            name: "diagram.png",
            file: { url: hostedUrl },
            caption: [{ plain_text: "Diagram" }],
          },
        },
      ],
      downloadAsset,
    })
    const markdown = files.find((file) => file.path.endsWith("index.md"))

    expect(downloadAsset).toHaveBeenCalledTimes(1)
    expect(downloadAsset).toHaveBeenCalledWith(
      expect.objectContaining({ url: hostedUrl }),
    )
    expect(downloadAsset.mock.calls[0]?.[0]?.url).not.toContain("file_uploads")
    expect(files.map((file) => file.path)).toEqual([
      "notion/pages/planning--page-1/index.md",
      "notion/pages/planning--page-1/assets/image-1--diagram.png",
    ])
    expect(markdown?.content).toContain(
      "[image: Pending](https://www.notion.so/planning-page-1)",
    )
    expect(markdown?.content).toContain(
      "![Diagram](./assets/image-1--diagram.png)",
    )
    expect(markdown?.content).not.toContain(uploadLifecycleUrl)
    expect(markdown?.content).not.toContain("file_uploads")
    expect(markdown?.content).not.toContain(hostedUrl)
    expect(markdown?.content).not.toContain("fu-1")
  })
})

describe("notionCommitFilesExcludingUnchanged", () => {
  it("skips binaries whose git blob SHA already matches the tree", () => {
    const bytes = Buffer.from("png-bytes")
    const file = connectorAssetCommitFile(
      "notion/pages/planning--page-1/assets/image-1--diagram.png",
      bytes,
    )
    const kept = notionCommitFilesExcludingUnchanged({
      files: [
        file,
        { path: "notion/pages/planning--page-1/index.md", content: "next\n" },
      ],
      existingBlobs: [
        { path: file.path, sha: gitBlobSha(bytes) },
        {
          path: "notion/pages/planning--page-1/index.md",
          sha: gitBlobSha(Buffer.from("stale\n")),
        },
      ],
    })

    expect(kept.map((entry) => entry.path)).toEqual([
      "notion/pages/planning--page-1/index.md",
    ])
  })
})
