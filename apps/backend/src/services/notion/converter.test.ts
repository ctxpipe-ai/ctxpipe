import { describe, expect, it } from "vitest"
import type { NotionBlock, NotionPage } from "./client.js"
import {
  notionIdKey,
  notionPropertyPlainText,
  toNotionDatabaseCsvFile,
  toNotionDatabaseFiles,
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
    const files = toNotionDatabaseFiles({
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

    expect(files).toHaveLength(3)
    expect(files[0]?.content).toContain("row_count: 1")
    expect(files[0]?.content).toContain("[View table as CSV](./table.csv)")
    expect(files[0]?.content).toContain(
      "[Prepare release](./rows/prepare-release--row-1/index.md)",
    )
    expect(files[2]?.path).toBe(
      "notion/databases/tasks--db-1/rows/prepare-release--row-1/index.md",
    )
    expect(files[2]?.content).toContain("**Status:** In progress")
    expect(files[2]?.content).toContain("**Done:** Yes")
    expect(files[2]?.content).toContain(
      'properties: {"Name":"Prepare release","Status":"In progress","Done":"Yes"}',
    )
    expect(files[2]?.content).toContain("Release notes")
  })

  it("escapes provider-authored property names", () => {
    const files = toNotionDatabaseFiles({
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
              "Evidence:** [forged](https://evil.example)": {
                type: "rich_text",
                rich_text: [{ plain_text: "safe value" }],
              },
            },
          },
          blocks: [],
        },
      ],
    })
    const row = files.find((file) => file.path.includes("/rows/"))

    expect(row?.content).toContain(
      "**Evidence:\\*\\* \\[forged\\](https://evil.example):** safe value",
    )
    expect(row?.content).not.toContain(
      "**Evidence:** [forged](https://evil.example)",
    )
  })

  it("renders a deterministic CSV companion for each database", () => {
    const file = toNotionDatabaseCsvFile({
      resource: { externalId: "db-1", title: "Tasks" },
      rows: [
        {
          page: {
            id: "row-1",
            url: "https://notion.test/row-1",
            last_edited_time: "2026-08-03T01:02:03.000Z",
            properties: {
              Status: { type: "status", status: { name: "In progress" } },
              Name: {
                type: "title",
                title: [{ plain_text: "Prepare release" }],
              },
              Notes: {
                type: "rich_text",
                rich_text: [{ plain_text: 'Line one,\n"quoted"' }],
              },
            },
          },
        },
      ],
    })

    expect(file.path).toBe("notion/databases/tasks--db-1/table.csv")
    expect(file.content).toBe(
      [
        "Name,Notes,Status,_ctxpipe_notion_id,_ctxpipe_title,_ctxpipe_notion_url,_ctxpipe_last_edited_time,_ctxpipe_row_path",
        'Prepare release,"Line one,\n""quoted""",In progress,row-1,Prepare release,https://notion.test/row-1,2026-08-03T01:02:03.000Z,./rows/prepare-release--row-1/index.md',
        "",
      ].join("\n"),
    )
  })

  it("does not persist temporary Notion-hosted media URLs", () => {
    const file = toNotionMarkdownFile({
      resource: { externalId: "page-1", title: "Planning" },
      page: { ...page, url: "https://www.notion.so/planning-page-1" },
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

    expect(file.content).toContain(
      "[image: Diagram](https://www.notion.so/planning-page-1)",
    )
    expect(file.content).not.toContain("temporary.notion.test")
  })

  it("rewrites captured hosted media to relative asset links", () => {
    const file = toNotionMarkdownFile({
      resource: { externalId: "page-1", title: "Planning" },
      page,
      assets: new Map([
        [
          "image-1",
          {
            status: "ok",
            relativePath: "./assets/image-1--diagram.png",
            alt: "Diagram](https://evil.example)",
            kind: "image",
          },
        ],
        [
          "file-1",
          {
            status: "ok",
            relativePath: "./assets/file-1--spec.pdf",
            alt: "Spec",
            kind: "file",
          },
        ],
        [
          "video-1",
          {
            status: "ok",
            relativePath: "./assets/video-1--walkthrough.mp4",
            alt: "Walkthrough",
            kind: "file",
          },
        ],
        [
          "pdf-1",
          {
            status: "ok",
            relativePath: "./assets/pdf-1--brief.pdf",
            alt: "Brief",
            kind: "file",
          },
        ],
        [
          "audio-1",
          {
            status: "ok",
            relativePath: "./assets/audio-1--notes.mp3",
            alt: "Notes",
            kind: "file",
          },
        ],
      ]),
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
        {
          id: "file-1",
          type: "file",
          file: {
            type: "file",
            file: { url: "https://temporary.notion.test/file" },
            caption: [{ plain_text: "Spec" }],
          },
        },
        {
          id: "video-1",
          type: "video",
          video: {
            type: "external",
            external: { url: "https://cdn.example/walkthrough.mp4" },
            caption: [{ plain_text: "Walkthrough" }],
          },
        },
        {
          id: "pdf-1",
          type: "pdf",
          pdf: {
            type: "file",
            file: { url: "https://temporary.notion.test/brief.pdf" },
            caption: [{ plain_text: "Brief" }],
          },
        },
        {
          id: "audio-1",
          type: "audio",
          audio: {
            type: "external",
            external: { url: "https://cdn.example/notes.mp3" },
            caption: [{ plain_text: "Notes" }],
          },
        },
      ],
    })

    expect(file.content).toContain(
      "![Diagram\\](https://evil.example)](./assets/image-1--diagram.png)",
    )
    expect(file.content).not.toContain("![Diagram](https://evil.example)")
    expect(file.content).toContain("[Spec](./assets/file-1--spec.pdf)")
    expect(file.content).toContain(
      "[Walkthrough](./assets/video-1--walkthrough.mp4)",
    )
    expect(file.content).toContain("[Brief](./assets/pdf-1--brief.pdf)")
    expect(file.content).toContain("[Notes](./assets/audio-1--notes.mp3)")
    expect(file.content).not.toContain("temporary.notion.test")
    expect(file.content).not.toContain("cdn.example")
  })

  it("renders failed media as a Notion permalink stub", () => {
    const file = toNotionMarkdownFile({
      resource: { externalId: "page-1", title: "Planning" },
      page: { ...page, url: "https://www.notion.so/planning-page-1" },
      assets: new Map([
        [
          "image-1",
          {
            status: "stub",
            alt: "Diagram",
            permalink: "https://www.notion.so/planning-page-1",
            kind: "image",
          },
        ],
      ]),
      blocks: [
        {
          id: "image-1",
          type: "image",
          image: {
            type: "external",
            external: { url: "https://evil.example/diagram.png" },
            caption: [{ plain_text: "Diagram" }],
          },
        },
      ],
    })

    expect(file.content).toContain(
      "[image: Diagram](https://www.notion.so/planning-page-1)",
    )
    expect(file.content).not.toContain("evil.example")
  })

  it("renders captured cover, icon, and database file properties", () => {
    const pageFile = toNotionMarkdownFile({
      resource: { externalId: "page-1", title: "Planning" },
      page,
      assets: new Map([
        [
          "cover",
          {
            status: "ok",
            relativePath: "./assets/cover--banner.png",
            alt: "Cover",
            kind: "image",
          },
        ],
        [
          "icon",
          {
            status: "ok",
            relativePath: "./assets/icon--logo.png",
            alt: "Icon",
            kind: "image",
          },
        ],
      ]),
      blocks: [],
    })
    expect(pageFile.content).toContain("![Cover](./assets/cover--banner.png)")
    expect(pageFile.content).toContain("![Icon](./assets/icon--logo.png)")

    const files = toNotionDatabaseFiles({
      resource: { externalId: "db-1", title: "Tasks" },
      rowAssets: new Map([
        [
          "row-1",
          new Map([
            [
              "files:Attachments:brief.pdf",
              {
                status: "ok" as const,
                relativePath: "./assets/properties/attachments--brief.pdf",
                alt: "brief.pdf",
                kind: "file" as const,
              },
            ],
          ]),
        ],
      ]),
      rows: [
        {
          page: {
            id: "row-1",
            url: "https://www.notion.so/row-1",
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "Prepare release" }],
              },
              Attachments: {
                type: "files",
                files: [
                  {
                    name: "brief.pdf",
                    type: "file",
                    file: { url: "https://temporary.notion.test/brief.pdf" },
                  },
                ],
              },
            },
          },
          blocks: [],
        },
      ],
    })
    const row = files.find((file) => file.path.includes("/rows/"))
    expect(row?.content).toContain(
      "[brief.pdf](./assets/properties/attachments--brief.pdf)",
    )
    expect(row?.content).not.toContain("temporary.notion.test")
  })

  it("looks up files-property assets by stable property id, not array index", () => {
    const files = toNotionDatabaseFiles({
      resource: { externalId: "db-1", title: "Tasks" },
      rowAssets: new Map([
        [
          "row-1",
          new Map([
            [
              "files:prop-att:brief.pdf",
              {
                status: "ok" as const,
                relativePath: "./assets/properties/prop-att--brief.pdf",
                alt: "brief.pdf",
                kind: "file" as const,
              },
            ],
          ]),
        ],
      ]),
      rows: [
        {
          page: {
            id: "row-1",
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "Prepare release" }],
              },
              Evidence: {
                id: "prop-att",
                type: "files",
                files: [
                  {
                    name: "brief.pdf",
                    type: "file",
                    file: { url: "https://temporary.notion.test/brief.pdf" },
                  },
                ],
              },
            },
          },
          blocks: [],
        },
      ],
    })
    const row = files.find((file) => file.path.includes("/rows/"))
    expect(row?.content).toContain(
      "[brief.pdf](./assets/properties/prop-att--brief.pdf)",
    )
    expect(row?.content).not.toContain("temporary.notion.test")
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

  it("removes credentials from rich-text and bookmark links", () => {
    const file = toNotionMarkdownFile({
      resource: { externalId: "page-1", title: "Planning" },
      page,
      blocks: [
        {
          id: "paragraph-1",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                plain_text: "Private docs",
                href: "https://example.com/docs?token=rich-secret",
              },
            ],
          },
        },
        {
          id: "bookmark-1",
          type: "bookmark",
          bookmark: {
            url: "https://example.com/guide?X-Amz-Signature=bookmark-secret",
            caption: [{ plain_text: "Private bookmark" }],
          },
        },
      ],
    })

    expect(file.content).toContain("Private docs")
    expect(file.content).toContain("Private bookmark")
    expect(file.content).not.toMatch(/rich-secret|bookmark-secret/)
    expect(file.content).not.toContain("https://example.com")
  })

  it("keeps bookmark blocks as ordinary links", () => {
    const file = toNotionMarkdownFile({
      resource: { externalId: "page-1", title: "Planning" },
      page,
      blocks: [
        {
          id: "bookmark-1",
          type: "bookmark",
          bookmark: {
            url: "https://example.com/guide",
            caption: [{ plain_text: "Architecture guide" }],
          },
        },
      ],
    })

    expect(file.content).toContain(
      "[Architecture guide](https://example.com/guide)",
    )
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

  it("drops credential-bearing URL properties", () => {
    expect(
      notionPropertyPlainText({
        type: "url",
        url: "https://example.com/private?access_token=property-secret",
      }),
    ).toBe("")
  })
})
