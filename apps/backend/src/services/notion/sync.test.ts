import { describe, expect, it } from "vitest"
import type { NotionBlock } from "./client.js"
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
})
