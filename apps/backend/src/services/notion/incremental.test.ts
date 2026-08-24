import { beforeEach, describe, expect, it, vi } from "vitest"
import { connectorAssetCommitFile } from "../connectors/assets.js"

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
    ]
    expect(managedNotionPagePathsForSubtree(paths, "child-1")).toEqual([
      "notion/pages/root--page-root-1/child--child-1/index.md",
    ])
  })
})

describe("buildNotionIncrementalChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it("includes captured binaries in the desired set and prunes stale assets", async () => {
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
        "notion/pages/root--page-root-1/assets/old-block--gone.png",
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

  it("keeps the resource when an asset download fails", async () => {
    mocks.downloadConnectorAsset.mockResolvedValue({
      status: "stub",
      reason: "download_failed",
    })
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
      existingPaths: [],
    })

    expect(result.failures).toEqual([])
    expect(result.files.map((file) => file.path)).toEqual([
      "notion/pages/root--page-root-1/index.md",
    ])
    const markdown = result.files[0]
    expect(markdown && "content" in markdown ? markdown.content : "").toContain(
      "[image: Broken](https://www.notion.so/root)",
    )
    expect(
      markdown && "content" in markdown ? markdown.content : "",
    ).not.toContain("images.example")
  })
})
