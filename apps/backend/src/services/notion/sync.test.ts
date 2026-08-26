import { describe, expect, it, vi } from "vitest"
import { connectorAssetCommitFile, gitBlobSha } from "../connectors/assets.js"
import {
  buildNotionPageMirrorFiles,
  notionCommitFilesExcludingUnchanged,
} from "./assets.js"
import type { NotionBlock, NotionPage } from "./client.js"
import { getNotionChildPageIds, getNotionDeletePaths } from "./sync.js"

describe("Notion page scope traversal", () => {
  it("finds child pages at every nested block level", () => {
    const blocks: NotionBlock[] = [
      {
        id: "child-1",
        type: "child_page",
      },
      {
        id: "toggle-1",
        type: "toggle",
        children: [
          {
            id: "child-2",
            type: "child_page",
          },
        ],
      },
    ]

    expect(getNotionChildPageIds(blocks)).toEqual(["child-1", "child-2"])
  })
})

describe("Notion stale file cleanup", () => {
  it("deletes files that are no longer in a complete sync", () => {
    expect(
      getNotionDeletePaths({
        managedRepoPaths: [
          "notion/pages/current.md",
          "notion/pages/removed.md",
        ],
        desiredPaths: new Set(["notion/pages/current.md"]),
        resourcesFailed: 0,
      }),
    ).toEqual(["notion/pages/removed.md"])
  })

  it("preserves existing files when any scoped resource fails", () => {
    expect(
      getNotionDeletePaths({
        managedRepoPaths: ["notion/pages/existing.md"],
        desiredPaths: new Set(),
        resourcesFailed: 1,
      }),
    ).toEqual([])
  })

  it("preserves only the transiently unavailable asset during a complete sync", () => {
    const prior =
      "notion/pages/root--page-1/assets/image-1--prior-screenshot.png"
    expect(
      getNotionDeletePaths({
        managedRepoPaths: [
          "notion/pages/root--page-1/index.md",
          prior,
          "notion/pages/root--page-1/assets/removed--old.png",
        ],
        desiredPaths: new Set(["notion/pages/root--page-1/index.md"]),
        resourcesFailed: 0,
        preservePathPrefixes: ["notion/pages/root--page-1/assets/image-1--"],
      }),
    ).toEqual(["notion/pages/root--page-1/assets/removed--old.png"])
  })

  it("reconciles full-sync desired binaries, prunes stale assets, and skips unchanged blobs", async () => {
    const bytes = Buffer.from("png-bytes")
    const page: NotionPage = {
      id: "page-1",
      url: "https://www.notion.so/planning-page-1",
      properties: {
        Name: { type: "title", title: [{ plain_text: "Planning" }] },
      },
    }
    const files = await buildNotionPageMirrorFiles({
      resource: { externalId: "page-1", title: "Planning" },
      page,
      blocks: [
        {
          id: "image-1",
          type: "image",
          image: {
            type: "file",
            name: "diagram.png",
            file: {
              url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/space/diagram.png?X-Amz-Signature=abc",
            },
            caption: [{ plain_text: "Diagram" }],
          },
        },
      ],
      downloadAsset: vi.fn().mockResolvedValue({
        status: "downloaded",
        bytes,
        filename: "diagram.png",
        contentType: "image/png",
      }),
    })
    const desiredPaths = new Set(files.map((file) => file.path))
    const assetPath =
      "notion/pages/planning--page-1/assets/image-1--diagram.png"

    expect([...desiredPaths]).toEqual([
      "notion/pages/planning--page-1/index.md",
      assetPath,
    ])
    expect(
      getNotionDeletePaths({
        managedRepoPaths: [
          "notion/pages/planning--page-1/index.md",
          assetPath,
          "notion/pages/planning--page-1/assets/old-block--gone.png",
        ],
        desiredPaths,
        resourcesFailed: 0,
      }),
    ).toEqual(["notion/pages/planning--page-1/assets/old-block--gone.png"])
    expect(
      notionCommitFilesExcludingUnchanged({
        files,
        existingBlobs: [{ path: assetPath, sha: gitBlobSha(bytes) }],
      }).map((file) => file.path),
    ).toEqual(["notion/pages/planning--page-1/index.md"])
    expect(files.find((file) => file.path === assetPath)).toEqual(
      connectorAssetCommitFile(assetPath, bytes),
    )
  })
})
