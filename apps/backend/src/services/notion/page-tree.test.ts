import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listChildren: vi.fn(),
  retrievePage: vi.fn(),
}))

vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>()
  return {
    ...actual,
    listNotionBlockChildren: mocks.listChildren,
    retrieveNotionPage: mocks.retrievePage,
  }
})

import { listNotionPageTree } from "./page-tree.js"

describe("listNotionPageTree", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("hands off each page before traversing its descendants", async () => {
    const events: string[] = []
    mocks.retrievePage.mockImplementation(
      async ({ pageId }: { pageId: string }) => {
        events.push(`retrieve:${pageId}`)
        return {
          id: pageId,
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: pageId }],
            },
          },
        }
      },
    )
    mocks.listChildren.mockImplementation(
      async ({ blockId }: { blockId: string }) => {
        events.push(`blocks:${blockId}`)
        return blockId === "root"
          ? [
              {
                id: "child",
                type: "child_page",
                has_children: true,
                child_page: { title: "Child" },
              },
            ]
          : []
      },
    )

    await listNotionPageTree({
      env: {} as never,
      connection: {} as never,
      rootPageId: "root",
      onTokenRefresh: undefined,
      onEntry: async ({ page }) => {
        events.push(`entry:${page.id}`)
      },
    })

    expect(events).toEqual([
      "retrieve:root",
      "blocks:root",
      "entry:root",
      "retrieve:child",
      "blocks:child",
      "entry:child",
    ])
  })

  it("does not descend into another explicitly selected page root", async () => {
    mocks.retrievePage.mockImplementation(
      async ({ pageId }: { pageId: string }) => ({
        id: pageId,
        properties: {
          Name: {
            type: "title",
            title: [{ plain_text: pageId }],
          },
        },
      }),
    )
    mocks.listChildren.mockImplementation(
      async ({ blockId }: { blockId: string }) =>
        blockId === "root"
          ? [{ id: "child", type: "child_page", has_children: true }]
          : [],
    )

    const entries = await listNotionPageTree({
      env: {} as never,
      connection: {} as never,
      rootPageId: "root",
      skipPageIds: new Set(["child"]),
      onTokenRefresh: undefined,
    })

    expect(entries.map((entry) => entry.page.id)).toEqual(["root"])
    expect(mocks.retrievePage).not.toHaveBeenCalledWith(
      expect.objectContaining({ pageId: "child" }),
    )
  })
})
