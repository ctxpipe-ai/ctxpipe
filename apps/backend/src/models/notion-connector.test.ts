import { describe, expect, it } from "vitest"
import { notionResourceSelectionChanged } from "./notion-connector.js"

const pageResource = {
  externalId: "page_1",
  type: "page" as const,
  title: "API",
  url: "https://notion.so/page-1",
  parentExternalId: null,
}
const databaseResource = {
  externalId: "database_1",
  type: "database" as const,
  title: "Tasks",
  url: null,
  parentExternalId: "page_1",
}
const selectedResources = [pageResource, databaseResource]

describe("notionResourceSelectionChanged", () => {
  it("treats the same selection in a different order as unchanged", () => {
    expect(
      notionResourceSelectionChanged(selectedResources, [
        databaseResource,
        pageResource,
      ]),
    ).toBe(false)
  })

  it("detects resource metadata changes", () => {
    expect(
      notionResourceSelectionChanged(selectedResources, [
        pageResource,
        { ...databaseResource, title: "Prioritised tasks" },
      ]),
    ).toBe(true)
  })

  it("does not accept duplicate resource IDs as the same selection", () => {
    expect(
      notionResourceSelectionChanged(selectedResources, [
        pageResource,
        pageResource,
      ]),
    ).toBe(true)
  })
})
