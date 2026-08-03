import { describe, expect, it } from "vitest"
import type { NotionBlock, NotionPage } from "./client.js"
import {
  notionIdKey,
  notionPropertyPlainText,
  toNotionDatabaseMarkdownFiles,
  toNotionMarkdownFile,
} from "./converter.js"

const page: NotionPage = {
  id: "page-1",
  properties: {
    Name: {
      type: "title",
      title: [{ plain_text: "Planning" }],
    },
  },
}

describe("Notion markdown conversion", () => {
  it("preserves checked tasks and nested blocks", () => {
    const blocks: NotionBlock[] = [
      {
        id: "todo-1",
        type: "to_do",
        to_do: { checked: true, rich_text: [{ plain_text: "Ship it" }] },
        children: [
          {
            id: "child-1",
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "With notes" }] },
          },
        ],
      },
    ]

    const file = toNotionMarkdownFile({
      resource: { externalId: "page-1", title: "Planning" },
      page,
      blocks,
    })

    expect(file.path).toBe("notion/pages/planning--page-1/index.md")
    expect(file.content).toContain("- [x] Ship it")
    expect(file.content).toContain("  With notes")
  })

  it("renders database rows with properties and page content", () => {
    const files = toNotionDatabaseMarkdownFiles({
      resource: { externalId: "db-1", title: "Tasks" },
      rows: [
        {
          page: {
            id: "row-1",
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "Prepare release" }],
              },
              Status: { type: "status", status: { name: "In progress" } },
              Done: { type: "checkbox", checkbox: true },
            },
          },
          blocks: [
            {
              id: "p-1",
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: "Release notes" }] },
            },
          ],
        },
      ],
    })

    expect(files).toHaveLength(2)
    expect(files[0]?.content).toContain("row_count: 1")
    expect(files[0]?.content).toContain(
      "[Prepare release](./rows/prepare-release--row-1/index.md)",
    )
    expect(files[1]?.path).toBe(
      "notion/databases/tasks--db-1/rows/prepare-release--row-1/index.md",
    )
    expect(files[1]?.content).toContain("**Status:** In progress")
    expect(files[1]?.content).toContain("**Done:** Yes")
    expect(files[1]?.content).toContain(
      'properties: {"Name":"Prepare release","Status":"In progress","Done":"Yes"}',
    )
    expect(files[1]?.content).toContain("Release notes")
  })

  it("does not persist temporary Notion-hosted media URLs", () => {
    const file = toNotionMarkdownFile({
      resource: { externalId: "page-1", title: "Planning" },
      page,
      blocks: [
        {
          id: "image-1",
          type: "image",
          image: {
            type: "file",
            file: { url: "https://temporary.notion.test/image" },
            caption: [{ plain_text: "Diagram" }],
          },
        },
      ],
    })

    expect(file.content).toContain("[image: Diagram]")
    expect(file.content).not.toContain("temporary.notion.test")
  })

  it("preserves external links and rewrites mirrored Notion page links", () => {
    const linkedPageId = "11111111-2222-3333-4444-555555555555"
    const linkedPath = `notion/pages/reference--${linkedPageId}/index.md`
    const file = toNotionMarkdownFile({
      resource: { externalId: "page-1", title: "Planning" },
      page,
      path: "notion/pages/planning--page-1/index.md",
      pathByNotionId: new Map([[notionIdKey(linkedPageId), linkedPath]]),
      blocks: [
        {
          id: "paragraph-1",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                plain_text: "External docs",
                href: "https://example.com/docs",
              },
              { plain_text: " and " },
              {
                plain_text: "Reference",
                href: `https://www.notion.so/Reference-${notionIdKey(linkedPageId)}`,
              },
            ],
          },
        },
        {
          id: linkedPageId,
          type: "child_page",
          child_page: { title: "Reference" },
        },
      ],
    })

    expect(file.content).toContain("[External docs](https://example.com/docs)")
    expect(file.content).toContain(
      `[Reference](../reference--${linkedPageId}/index.md)`,
    )
    expect(file.content).not.toContain("www.notion.so/Reference")
  })
})

describe("notionPropertyPlainText", () => {
  it("formats common task properties", () => {
    expect(
      notionPropertyPlainText({
        type: "multi_select",
        multi_select: [{ name: "engineering" }, { name: "urgent" }],
      }),
    ).toBe("engineering, urgent")
    expect(
      notionPropertyPlainText({
        type: "date",
        date: { start: "2026-07-24", end: null },
      }),
    ).toBe("2026-07-24")
  })
})
