import { describe, expect, it } from "vitest"
import type { NotionBlock } from "./client.js"
import { getNotionChildPageIds } from "./sync.js"

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
