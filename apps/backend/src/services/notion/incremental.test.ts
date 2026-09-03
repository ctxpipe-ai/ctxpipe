import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  connectorAssetCommitFile,
  createConnectorAssetBytePool,
  gitBlobSha,
} from "../connectors/assets.js"

const mocks = vi.hoisted(() => ({
  retrieveNotionPage: vi.fn(),
  listNotionBlockChildren: vi.fn(),
  queryNotionDatabase: vi.fn(),
  downloadConnectorAsset: vi.fn(),
}))

const titles: Record<string, string> = {
  "page-root-1": "Root",
  "row-1": "Row 1",
}

vi.mock("./client.js", () => ({
  retrieveNotionPage: mocks.retrieveNotionPage,
  listNotionBlockChildren: mocks.listNotionBlockChildren,
  queryNotionDatabase: mocks.queryNotionDatabase,
  getNotionPageTitle: (page: { id: string }) => titles[page.id] ?? "Untitled",
}))

vi.mock("../connectors/assets.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../connectors/assets.js")>()
  return {
    ...actual,
    downloadConnectorAsset: mocks.downloadConnectorAsset,
  }
})

import type { NotionConnection } from "../../models/notion-connector.js"
import type { ParsedNotionRepoConfig } from "./config-yaml.js"
import {
  buildNotionIncrementalChanges,
  managedNotionDatabasePaths,
  managedNotionPagePathsForRoot,
  managedNotionPagePathsForSubtree,
  notionSegmentId,
} from "./incremental.js"

const env = {} as never
const connection = { id: "con_1", accessToken: "tok" } as NotionConnection

const config: ParsedNotionRepoConfig = {
  resources: [
    { externalId: "page-root-1", type: "page", title: "Root" },
    { externalId: "ds-1", type: "database", title: "Tasks" },
  ],
}

describe("Notion managed path helpers", () => {
  it("extracts the trailing id from a slug--id segment", () => {
    expect(notionSegmentId("root--page-root-1")).toBe("page-root-1")
    expect(notionSegmentId("no-marker")).toBe("")
  })

  it("selects database files by the first database segment id", () => {
    const paths = [
      "notion/databases/tasks--ds-1/index.md",
      "notion/databases/tasks--ds-1/rows/row-1--row-1/index.md",
      "notion/databases/other--ds-2/index.md",
      "notion/pages/root--page-root-1/index.md",
    ]
    expect(managedNotionDatabasePaths(paths, "ds-1")).toEqual([
      "notion/databases/tasks--ds-1/index.md",
      "notion/databases/tasks--ds-1/rows/row-1--row-1/index.md",
    ])
  })

  it("selects page files by their subtree root", () => {
    const paths = [
      "notion/pages/root--page-root-1/index.md",
      "notion/pages/root--page-root-1/child--child-1/index.md",
      "notion/pages/other--page-2/index.md",
    ]
    expect(managedNotionPagePathsForRoot(paths, "page-root-1")).toEqual([
      "notion/pages/root--page-root-1/index.md",
      "notion/pages/root--page-root-1/child--child-1/index.md",
    ])
  })

  it("selects a page and its descendants for subtree deletes", () => {
    const paths = [
      "notion/pages/root--page-root-1/index.md",
      "notion/pages/root--page-root-1/child--child-1/index.md",
      "notion/pages/other--page-2/index.md",
      "notion/databases/tasks--ds-1/rows/task--child-1/index.md",
      "notion/databases/tasks--ds-1/rows/task--child-1/assets/file.png",
    ]
    expect(managedNotionPagePathsForSubtree(paths, "child-1")).toEqual([
      "notion/pages/root--page-root-1/child--child-1/index.md",
      "notion/databases/tasks--ds-1/rows/task--child-1/index.md",
      "notion/databases/tasks--ds-1/rows/task--child-1/assets/file.png",
    ])
  })
})

describe("buildNotionIncrementalChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    titles["page-root-1"] = "Root"
    mocks.listNotionBlockChildren.mockResolvedValue([])
    mocks.retrieveNotionPage.mockImplementation(
      async ({ pageId }: { pageId: string }) => ({
        id: pageId,
        parent: { type: "workspace", workspace: true },
        properties: {},
      }),
    )
    mocks.queryNotionDatabase.mockResolvedValue([])
    mocks.downloadConnectorAsset.mockResolvedValue({
      status: "downloaded",
      bytes: Buffer.from("png-bytes"),
      filename: "diagram.png",
      contentType: "image/png",
    })
  })

  it("no-ops when a page is not in the current git scope", async () => {
    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config,
      entity: { entityType: "page", externalId: "orphan-1", action: "upsert" },
      existingPaths: [],
    })

    expect(result.files).toEqual([])
    expect(result.deletePaths).toEqual([])
    expect(result.failures).toEqual([])
  })

  it("re-mirrors a selected page subtree and prunes stale descendants", async () => {
    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config,
      entity: {
        entityType: "page",
        externalId: "page-root-1",
        action: "upsert",
      },
      existingPaths: [
        "notion/pages/root--page-root-1/index.md",
        "notion/pages/root--page-root-1/stale--stale-1/index.md",
        "notion/databases/tasks--ds-1/index.md",
      ],
    })

    expect(result.failures).toEqual([])
    expect(result.files.map((file) => file.path)).toEqual([
      "notion/pages/root--page-root-1/index.md",
    ])
    expect(result.deletePaths).toEqual([
      "notion/pages/root--page-root-1/stale--stale-1/index.md",
    ])
  })

  it("does not remirror another explicitly selected page below its parent", async () => {
    titles["child-1"] = "Child"
    mocks.listNotionBlockChildren.mockImplementation(
      async ({ blockId }: { blockId: string }) =>
        blockId === "page-root-1"
          ? [
              {
                id: "child-1",
                type: "child_page",
                has_children: true,
                child_page: { title: "Child" },
              },
            ]
          : [],
    )

    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config: {
        resources: [
          { externalId: "page-root-1", type: "page", title: "Root" },
          { externalId: "child-1", type: "page", title: "Child" },
        ],
      },
      entity: {
        entityType: "page",
        externalId: "page-root-1",
        action: "upsert",
      },
      existingPaths: [
        "notion/pages/root--page-root-1/index.md",
        "notion/pages/root--page-root-1/child--child-1/index.md",
        "notion/pages/child--child-1/index.md",
      ],
    })

    expect(result.failures).toEqual([])
    expect(result.files.map((file) => file.path)).toEqual([
      "notion/pages/root--page-root-1/index.md",
    ])
    expect(result.files[0]?.content).toContain(
      "[Child](../child--child-1/index.md)",
    )
    expect(result.deletePaths).toEqual([
      "notion/pages/root--page-root-1/child--child-1/index.md",
    ])
    expect(mocks.retrieveNotionPage).not.toHaveBeenCalledWith(
      expect.objectContaining({ pageId: "child-1" }),
    )
  })

  it("prunes the old subtree path when a page moves between selected roots", async () => {
    titles["page-root-2"] = "Root Two"
    titles["moved-1"] = "Moved"
    mocks.retrieveNotionPage.mockImplementation(
      async ({ pageId }: { pageId: string }) => ({
        id: pageId,
        parent:
          pageId === "moved-1"
            ? { type: "page_id", page_id: "page-root-2" }
            : { type: "workspace", workspace: true },
        properties: {},
      }),
    )
    mocks.listNotionBlockChildren.mockImplementation(
      async ({ blockId }: { blockId: string }) =>
        blockId === "page-root-2"
          ? [
              {
                id: "moved-1",
                type: "child_page",
                has_children: true,
                child_page: { title: "Moved" },
              },
            ]
          : [],
    )

    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config: {
        resources: [
          { externalId: "page-root-1", type: "page", title: "Root" },
          { externalId: "page-root-2", type: "page", title: "Root Two" },
        ],
      },
      entity: { entityType: "page", externalId: "moved-1", action: "upsert" },
      existingPaths: [
        "notion/pages/root--page-root-1/moved--moved-1/index.md",
        "notion/pages/root--page-root-1/moved--moved-1/assets/old.png",
        "notion/pages/root-two--page-root-2/index.md",
      ],
    })

    expect(result.failures).toEqual([])
    expect(result.files.map((file) => file.path)).toContain(
      "notion/pages/root-two--page-root-2/moved--moved-1/index.md",
    )
    expect(result.deletePaths).toEqual(
      expect.arrayContaining([
        "notion/pages/root--page-root-1/moved--moved-1/index.md",
        "notion/pages/root--page-root-1/moved--moved-1/assets/old.png",
      ]),
    )
  })

  it("prunes a page-tree copy when the page moves into a selected database", async () => {
    titles["moved-1"] = "Moved"
    mocks.retrieveNotionPage.mockResolvedValue({
      id: "moved-1",
      parent: { type: "data_source_id", data_source_id: "ds-1" },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Moved" }] },
      },
    })
    mocks.queryNotionDatabase.mockResolvedValue([
      {
        id: "moved-1",
        properties: {
          Name: { type: "title", title: [{ plain_text: "Moved" }] },
        },
      },
    ])

    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config,
      entity: { entityType: "page", externalId: "moved-1", action: "upsert" },
      existingPaths: [
        "notion/pages/root--page-root-1/moved--moved-1/index.md",
        "notion/pages/root--page-root-1/moved--moved-1/assets/old.png",
        "notion/databases/tasks--ds-1/index.md",
      ],
    })

    expect(result.failures).toEqual([])
    expect(result.files.map((file) => file.path)).toContain(
      "notion/databases/tasks--ds-1/rows/moved--moved-1/index.md",
    )
    expect(result.deletePaths).toEqual(
      expect.arrayContaining([
        "notion/pages/root--page-root-1/moved--moved-1/index.md",
        "notion/pages/root--page-root-1/moved--moved-1/assets/old.png",
      ]),
    )
  })

  it("re-mirrors a database when a data_source event fires", async () => {
    mocks.queryNotionDatabase.mockResolvedValue([
      {
        id: "row-1",
        properties: {
          Name: { type: "title", title: [{ plain_text: "Row 1" }] },
        },
      },
    ])

    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config,
      entity: {
        entityType: "data_source",
        externalId: "ds-1",
        action: "upsert",
      },
      existingPaths: [],
    })

    expect(result.failures).toEqual([])
    expect(mocks.queryNotionDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ databaseId: "ds-1" }),
    )
    expect(result.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "notion/databases/tasks--ds-1/index.md",
        "notion/databases/tasks--ds-1/table.csv",
        "notion/databases/tasks--ds-1/rows/row-1--row-1/index.md",
      ]),
    )
  })

  it("does not remirror an explicitly selected page as a database row", async () => {
    mocks.queryNotionDatabase.mockResolvedValue([
      {
        id: "row-1",
        properties: {
          Name: { type: "title", title: [{ plain_text: "Row 1" }] },
        },
      },
    ])

    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config: {
        resources: [
          { externalId: "ds-1", type: "database", title: "Tasks" },
          { externalId: "row-1", type: "page", title: "Row 1" },
        ],
      },
      entity: {
        entityType: "data_source",
        externalId: "ds-1",
        action: "upsert",
      },
      existingPaths: [],
    })

    expect(result.failures).toEqual([])
    expect(result.files.map((file) => file.path)).toEqual([
      "notion/databases/tasks--ds-1/index.md",
      "notion/databases/tasks--ds-1/table.csv",
    ])
    expect(mocks.listNotionBlockChildren).not.toHaveBeenCalled()
  })

  it("deletes a page subtree without fetching when the page is removed", async () => {
    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config,
      entity: {
        entityType: "page",
        externalId: "page-root-1",
        action: "delete",
      },
      existingPaths: [
        "notion/pages/root--page-root-1/index.md",
        "notion/pages/root--page-root-1/child--child-1/index.md",
      ],
    })

    expect(mocks.retrieveNotionPage).not.toHaveBeenCalled()
    expect(result.files).toEqual([])
    expect(result.deletePaths).toEqual([
      "notion/pages/root--page-root-1/index.md",
      "notion/pages/root--page-root-1/child--child-1/index.md",
    ])
  })

  it("deletes a database row and its assets on a page delete event", async () => {
    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config,
      entity: {
        entityType: "page",
        externalId: "row-1",
        action: "delete",
      },
      existingPaths: [
        "notion/databases/tasks--ds-1/rows/task--row-1/index.md",
        "notion/databases/tasks--ds-1/rows/task--row-1/assets/file.png",
      ],
    })

    expect(mocks.retrieveNotionPage).not.toHaveBeenCalled()
    expect(result.files).toEqual([])
    expect(result.deletePaths).toEqual([
      "notion/databases/tasks--ds-1/rows/task--row-1/index.md",
      "notion/databases/tasks--ds-1/rows/task--row-1/assets/file.png",
    ])
  })

  it("drops a database out of scope by deleting its managed files", async () => {
    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config,
      entity: {
        entityType: "database",
        externalId: "ds-unknown",
        action: "upsert",
      },
      existingPaths: ["notion/databases/gone--ds-unknown/index.md"],
    })

    expect(mocks.queryNotionDatabase).not.toHaveBeenCalled()
    expect(result.files).toEqual([])
    expect(result.deletePaths).toEqual([
      "notion/databases/gone--ds-unknown/index.md",
    ])
  })

  it("recommits changed binaries and prunes stale assets", async () => {
    mocks.retrieveNotionPage.mockResolvedValue({
      id: "page-root-1",
      url: "https://www.notion.so/root",
      parent: { type: "workspace", workspace: true },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Root" }] },
      },
    })
    mocks.listNotionBlockChildren.mockResolvedValue([
      {
        id: "image-1",
        type: "image",
        image: {
          type: "file",
          name: "diagram.png",
          file: {
            url: "https://prod-files-secure.s3.amazonaws.com/diagram.png",
          },
          caption: [{ plain_text: "Diagram" }],
        },
      },
    ])

    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config,
      entity: {
        entityType: "page",
        externalId: "page-root-1",
        action: "upsert",
      },
      existingPaths: [
        "notion/pages/root--page-root-1/index.md",
        "notion/pages/root--page-root-1/assets/image-1--diagram.png",
        "notion/pages/root--page-root-1/assets/old-block--gone.png",
      ],
      existingBlobs: [
        {
          path: "notion/pages/root--page-root-1/assets/image-1--diagram.png",
          sha: gitBlobSha(Buffer.from("old-png")),
        },
      ],
    })

    expect(result.failures).toEqual([])
    expect(result.files.map((file) => file.path)).toEqual([
      "notion/pages/root--page-root-1/index.md",
      "notion/pages/root--page-root-1/assets/image-1--diagram.png",
    ])
    expect(result.files[1]).toEqual(
      connectorAssetCommitFile(
        "notion/pages/root--page-root-1/assets/image-1--diagram.png",
        Buffer.from("png-bytes"),
      ),
    )
    const markdown = result.files[0]
    expect(markdown && "content" in markdown ? markdown.content : "").toContain(
      "![Diagram](./assets/image-1--diagram.png)",
    )
    expect(result.deletePaths).toEqual([
      "notion/pages/root--page-root-1/assets/old-block--gone.png",
    ])
  })

  it("suppresses unchanged binaries before applying the incremental byte pool", async () => {
    const bytes = Buffer.from("png-bytes")
    const assetPath =
      "notion/pages/root--page-root-1/assets/image-1--diagram.png"
    mocks.retrieveNotionPage.mockResolvedValue({
      id: "page-root-1",
      url: "https://www.notion.so/root",
      parent: { type: "workspace", workspace: true },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Root" }] },
      },
    })
    mocks.listNotionBlockChildren.mockResolvedValue([
      {
        id: "image-1",
        type: "image",
        image: {
          type: "file",
          name: "diagram.png",
          file: {
            url: "https://prod-files-secure.s3.amazonaws.com/diagram.png",
          },
          caption: [{ plain_text: "Diagram" }],
        },
      },
    ])

    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config,
      entity: {
        entityType: "page",
        externalId: "page-root-1",
        action: "upsert",
      },
      existingPaths: [assetPath],
      existingBlobs: [{ path: assetPath, sha: gitBlobSha(bytes) }],
      bytePool: createConnectorAssetBytePool(0, 0),
    })

    expect(result.files.map((file) => file.path)).toEqual([
      "notion/pages/root--page-root-1/index.md",
    ])
    expect(result.deletePaths).toEqual([])
    const markdown = result.files[0]
    expect(markdown && "content" in markdown ? markdown.content : "").toContain(
      "![Diagram](./assets/image-1--diagram.png)",
    )
  })

  it("keeps the prior binary when an asset download fails", async () => {
    titles["page-root-1"] = "Renamed"
    mocks.downloadConnectorAsset.mockResolvedValue({
      status: "stub",
      reason: "download_failed",
    })
    mocks.retrieveNotionPage.mockResolvedValue({
      id: "page-root-1",
      url: "https://www.notion.so/root",
      parent: { type: "workspace", workspace: true },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Renamed" }] },
      },
    })
    mocks.listNotionBlockChildren.mockResolvedValue([
      {
        id: "image-1",
        type: "image",
        image: {
          type: "external",
          external: { url: "https://images.example/broken.png" },
          caption: [{ plain_text: "Broken" }],
        },
      },
    ])

    const result = await buildNotionIncrementalChanges({
      env,
      connection,
      config,
      entity: {
        entityType: "page",
        externalId: "page-root-1",
        action: "upsert",
      },
      existingPaths: [
        "notion/pages/root--page-root-1/index.md",
        "notion/pages/root--page-root-1/assets/image-1--prior.png",
        "notion/pages/root--page-root-1/assets/removed--old.png",
      ],
    })

    expect(result.failures).toEqual([])
    expect(result.files.map((file) => file.path)).toEqual([
      "notion/pages/renamed--page-root-1/index.md",
    ])
    const markdown = result.files[0]
    expect(markdown && "content" in markdown ? markdown.content : "").toContain(
      "[image: Broken](https://www.notion.so/root)",
    )
    expect(
      markdown && "content" in markdown ? markdown.content : "",
    ).not.toContain("images.example")
    expect(result.deletePaths).toEqual([
      "notion/pages/root--page-root-1/index.md",
      "notion/pages/root--page-root-1/assets/removed--old.png",
    ])
  })
})
