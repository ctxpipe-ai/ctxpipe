import { describe, expect, it } from "vitest"
import {
  confluenceScopeToSpaceItems,
  confluenceSpaceItemsToScope,
} from "./confluence"

describe("Confluence scope and the page tree selection", () => {
  it("maps all pages to null and a page list to its ids, both ways", () => {
    const scope = {
      spaces: [
        { key: "ENG", pages: "all" },
        { key: "OPS", pages: ["101", "202"] },
      ],
    }
    const items = confluenceScopeToSpaceItems(scope)
    expect(items).toEqual([
      { spaceKey: "ENG", selectedPageIds: null },
      { spaceKey: "OPS", selectedPageIds: ["101", "202"] },
    ])
    expect(confluenceSpaceItemsToScope(items)).toEqual(scope)
  })

  it("starts empty from an add, and is not complete without a space or page", () => {
    expect(confluenceScopeToSpaceItems({})).toEqual([])
    expect(confluenceSpaceItemsToScope([])).toBeNull()
    expect(
      confluenceSpaceItemsToScope([{ spaceKey: "ENG", selectedPageIds: [] }]),
    ).toBeNull()
  })
})
