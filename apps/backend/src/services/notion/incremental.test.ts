import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  retrieveNotionPage: vi.fn(),
  listNotionBlockChildren: vi.fn(),
  queryNotionDatabase: vi.fn(),
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
})
