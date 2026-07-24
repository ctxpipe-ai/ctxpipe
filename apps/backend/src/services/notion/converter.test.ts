import { describe, expect, it } from "vitest"
import type { NotionBlock, NotionPage } from "./client.js"
import {
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
      "[Prepare release](./tasks--db-1/prepare-release--row-1.md)",
    )
    expect(files[1]?.path).toBe(
      "notion/databases/tasks--db-1/prepare-release--row-1.md",
    )
    expect(files[1]?.content).toContain("**Status:** In progress")
    expect(files[1]?.content).toContain("**Done:** Yes")
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
