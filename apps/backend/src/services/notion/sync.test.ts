import { beforeEach, describe, expect, it, vi } from "vitest"

const limitMock = vi.hoisted(() => vi.fn())
const whereMock = vi.hoisted(() => vi.fn(() => ({ limit: limitMock })))
const fromMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })))
const selectMock = vi.hoisted(() => vi.fn(() => ({ from: fromMock })))
const github = vi.hoisted(() => ({
  commitFiles: vi.fn(),
  listFilesInTree: vi.fn(),
}))
const notion = vi.hoisted(() => ({
  downloadConnectorAsset: vi.fn(),
  listNotionBlockChildren: vi.fn(),
  queryNotionDatabase: vi.fn(),
  retrieveNotionPage: vi.fn(),
}))

vi.mock("../../db/client.js", () => ({
  getOrgDb: () => ({ select: selectMock }),
  withOrgDbContext: (_orgId: string, action: () => unknown) => action(),
}))
vi.mock("../../models/notion-connector.js", () => ({
  refreshNotionConnectionTokensWithLock: vi.fn(),
}))
vi.mock("../github/installation-write-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../github/installation-write-client.js")
    >()
  return { ...actual, ...github }
})
vi.mock("../connectors/assets.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../connectors/assets.js")>()
  return {
    ...actual,
    createConnectorAssetBytePool: () =>
      actual.createConnectorAssetBytePool(10, 2),
    downloadConnectorAsset: notion.downloadConnectorAsset,
  }
})
vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>()
  return { ...actual, ...notion }
})

import { connectorAssetCommitFile, gitBlobSha } from "../connectors/assets.js"
import {
  buildNotionPageMirrorFiles,
  notionCommitFilesExcludingUnchanged,
} from "./assets.js"
import type { NotionBlock, NotionPage } from "./client.js"
import {
  getNotionChildPageIds,
  getNotionDeletePaths,
  syncNotionContent,
} from "./sync.js"

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

describe("syncNotionContent connector contract", () => {
  const binding = {
    id: "nb_1",
    repositoryId: "repo_1",
    branch: "main",
    enabled: true,
    setupPhase: "live",
  } as never
  const notionConnection = {
    id: "con_notion",
    accessToken: "notion-token",
    refreshToken: null,
  } as never
  const notionPage = (id: string, title: string): NotionPage => ({
    id,
    url: `https://www.notion.so/${id}`,
    properties: {
      Name: { type: "title", title: [{ plain_text: title }] },
    },
  })
  const imageBlock = (id: string): NotionBlock => ({
    id,
    type: "image",
    image: {
      type: "file",
      name: `${id}.png`,
      file: {
        url: `https://prod-files-secure.s3.amazonaws.com/${id}.png`,
      },
      caption: [{ plain_text: id }],
    },
  })

  beforeEach(() => {
    vi.clearAllMocks()
    limitMock.mockResolvedValue([
      { name: "acme/docs", githubConnectionId: "ghc_1" },
    ])
    github.listFilesInTree.mockResolvedValue([])
    github.commitFiles.mockResolvedValue({ commitSha: "commit-1" })
    notion.queryNotionDatabase.mockResolvedValue([])
    notion.downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: Buffer.from("asset"),
      filename: "image.png",
      contentType: "image/png",
    })
  })

  it("runs provider traversal, asset capture, and Git reconciliation through the public seam", async () => {
    github.listFilesInTree.mockResolvedValue([
      {
        path: "notion/pages/removed--old-page/index.md",
        sha: "old",
      },
    ])
    notion.retrieveNotionPage.mockResolvedValue(
      notionPage("page-1", "Planning"),
    )
    notion.listNotionBlockChildren.mockResolvedValue([imageBlock("diagram")])

    const result = await syncNotionContent({
      orgId: "org_1",
      env: {} as never,
      notionConnection,
      binding,
      scopeFromRepo: {
        resources: [{ externalId: "page-1", type: "page", title: "Planning" }],
      },
    })

    expect(result.errors).toEqual([])
    expect(result).toMatchObject({
      status: "completed",
      resourcesProcessed: 1,
      resourcesFailed: 0,
      commitSha: "commit-1",
    })
    expect(github.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "notion/pages/planning--page-1/index.md",
          }),
          expect.objectContaining({
            path: "notion/pages/planning--page-1/assets/diagram--image.png",
          }),
        ]),
        deletePaths: ["notion/pages/removed--old-page/index.md"],
      }),
    )
  })

  it("processes duplicate normalised resource ids only once", async () => {
    const dashedId = "11111111-2222-3333-4444-555555555555"
    const compactId = dashedId.replaceAll("-", "")
    notion.retrieveNotionPage.mockResolvedValue(
      notionPage(dashedId, "Planning"),
    )
    notion.listNotionBlockChildren.mockResolvedValue([imageBlock("diagram")])

    const result = await syncNotionContent({
      orgId: "org_1",
      env: {} as never,
      notionConnection,
      binding,
      scopeFromRepo: {
        resources: [
          { externalId: dashedId, type: "page", title: "Planning" },
          { externalId: compactId, type: "page", title: "Duplicate" },
        ],
      },
    })

    expect(result).toMatchObject({
      status: "completed",
      resourcesProcessed: 1,
      resourcesFailed: 0,
    })
    expect(notion.retrieveNotionPage).toHaveBeenCalledTimes(1)
    expect(notion.downloadConnectorAsset).toHaveBeenCalledTimes(1)
  })

  it("mirrors an explicitly selected child only at its own root", async () => {
    notion.retrieveNotionPage.mockImplementation(
      ({ pageId }: { pageId: string }) =>
        Promise.resolve(
          notionPage(pageId, pageId === "root" ? "Root" : "Child"),
        ),
    )
    notion.listNotionBlockChildren.mockImplementation(
      ({ blockId }: { blockId: string }) =>
        Promise.resolve(
          blockId === "root"
            ? [{ id: "child", type: "child_page" }]
            : [imageBlock("child-image")],
        ),
    )
    github.listFilesInTree.mockResolvedValue([
      {
        path: "notion/pages/root--root/child--child/index.md",
        sha: "old-child",
      },
      {
        path: "notion/pages/root--root/child--child/assets/child-image--old.png",
        sha: "old-asset",
      },
    ])

    const result = await syncNotionContent({
      orgId: "org_1",
      env: {} as never,
      notionConnection,
      binding,
      scopeFromRepo: {
        resources: [
          { externalId: "root", type: "page", title: "Root" },
          { externalId: "child", type: "page", title: "Child" },
        ],
      },
    })

    expect(result.resourcesProcessed).toBe(2)
    expect(notion.retrieveNotionPage).toHaveBeenCalledTimes(2)
    expect(notion.downloadConnectorAsset).toHaveBeenCalledTimes(1)
    const commit = github.commitFiles.mock.calls[0]?.[0] as {
      files: Array<{ path: string }>
      deletePaths: string[]
    }
    expect(commit.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "notion/pages/root--root/index.md",
        "notion/pages/child--child/index.md",
        "notion/pages/child--child/assets/child-image--image.png",
      ]),
    )
    expect(commit.files.map((file) => file.path)).not.toContain(
      "notion/pages/root--root/child--child/assets/child-image--image.png",
    )
    expect(commit.deletePaths).toEqual([
      "notion/pages/root--root/child--child/index.md",
      "notion/pages/root--root/child--child/assets/child-image--old.png",
    ])
  })

  it("does not mirror an explicitly selected page as a database row", async () => {
    const selectedRow = notionPage("row-1", "Selected row")
    notion.queryNotionDatabase.mockResolvedValue([selectedRow])
    notion.retrieveNotionPage.mockResolvedValue(selectedRow)
    notion.listNotionBlockChildren.mockResolvedValue([])

    await syncNotionContent({
      orgId: "org_1",
      env: {} as never,
      notionConnection,
      binding,
      scopeFromRepo: {
        resources: [
          { externalId: "db-1", type: "database", title: "Tasks" },
          { externalId: "row-1", type: "page", title: "Selected row" },
        ],
      },
    })

    const paths = (
      github.commitFiles.mock.calls[0]?.[0]?.files as Array<{ path: string }>
    ).map((file) => file.path)
    expect(paths).toContain("notion/pages/selected-row--row-1/index.md")
    expect(paths).not.toContain(
      "notion/databases/tasks--db-1/rows/selected-row--row-1/index.md",
    )
    expect(notion.listNotionBlockChildren).toHaveBeenCalledTimes(1)
  })

  it("rolls back a failed resource's byte reservations before the next resource", async () => {
    notion.retrieveNotionPage.mockImplementation(
      ({ pageId }: { pageId: string }) => {
        if (pageId === "child-fail") {
          throw new Error("child unavailable")
        }
        return Promise.resolve(notionPage(pageId, pageId))
      },
    )
    notion.listNotionBlockChildren.mockImplementation(
      ({ blockId }: { blockId: string }) =>
        Promise.resolve(
          blockId === "first"
            ? [
                imageBlock("first-image"),
                { id: "child-fail", type: "child_page" },
              ]
            : [imageBlock("second-image")],
        ),
    )
    notion.downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: Buffer.from("123456"),
      filename: "asset.png",
      contentType: "image/png",
    })

    const result = await syncNotionContent({
      orgId: "org_1",
      env: {} as never,
      notionConnection,
      binding,
      scopeFromRepo: {
        resources: [
          { externalId: "first", type: "page", title: "First" },
          { externalId: "second", type: "page", title: "Second" },
        ],
      },
    })

    expect(result).toMatchObject({
      status: "partial_failed",
      resourcesProcessed: 1,
      resourcesFailed: 1,
    })
    const committed = github.commitFiles.mock.calls[0]?.[0]?.files as Array<{
      path: string
    }>
    expect(committed.map((file) => file.path)).toContain(
      "notion/pages/second--second/assets/second-image--asset.png",
    )
    expect(committed.map((file) => file.path)).not.toContain(
      "notion/pages/first--first/assets/first-image--asset.png",
    )
  })
})
