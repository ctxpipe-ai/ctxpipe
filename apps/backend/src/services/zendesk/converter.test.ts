import { describe, expect, it } from "vitest"
import {
  type ZendeskArticleForMirror,
  type ZendeskTicketForMirror,
  zendeskArticleFile,
  zendeskTicketFile,
} from "./converter.js"

const article: ZendeskArticleForMirror = {
  id: "360000000001",
  title: "Reset a password",
  url: "https://acme.zendesk.com/hc/en-us/articles/360000000001-Reset-a-password",
  bodyHtml: [
    "<h2>Steps</h2>",
    '<p>Open <strong>Settings</strong> and select <a href="https://acme.zendesk.com/hc/en-us/articles/2">Security</a>.</p>',
    "<ul><li>One</li><li>Two</li></ul>",
    '<p><img src="https://acme.zendesk.com/hc/article_attachments/9/shot.png" alt="Settings screen"></p>',
    "<pre><code>npm run reset</code></pre>",
    '<p>Log: <a href="https://files.example.com/log?X-Amz-Signature=abc123">signed</a></p>',
  ].join(""),
  sectionId: "360000000010",
  sectionName: "Accounts",
  locale: "en-us",
  labels: ["password", "login"],
  authorName: "Sam Rivera",
  createdAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-10-12T10:00:00Z",
}

const ticket: ZendeskTicketForMirror = {
  id: "4501",
  subject: "Export fails | large files",
  url: "https://acme.zendesk.com/agent/tickets/4501",
  status: "open",
  priority: "high",
  type: "problem",
  tags: ["export", "bug"],
  requesterName: "Alex Kim",
  assigneeName: "Sam Rivera",
  createdAt: "2026-10-10T09:00:00Z",
  updatedAt: "2026-10-12T11:00:00Z",
  comments: [
    {
      authorName: "Alex Kim",
      createdAt: "2026-10-10T09:00:00Z",
      public: true,
      body: "The export stops at 2 GB.\n\nSee the attached log.",
      attachments: ["export.log"],
    },
    {
      authorName: "Sam Rivera",
      createdAt: "2026-10-11T10:00:00Z",
      public: false,
      body: "Repro on staging. Linked to ENG-42.",
      attachments: [],
    },
  ],
}

describe("zendeskArticleFile", () => {
  const file = zendeskArticleFile({ categoryId: "360000000100", article })

  it("writes the article under its category, with a stable path", () => {
    expect(file.path).toBe(
      "zendesk/help-center/categories/360000000100/reset-a-password--360000000001.md",
    )
  })

  it("renders the front matter and the body as Markdown", () => {
    expect(file.content).toBe(
      [
        "---",
        'source: "zendesk"',
        'zendesk_id: "360000000001"',
        'url: "https://acme.zendesk.com/hc/en-us/articles/360000000001-Reset-a-password"',
        'category_id: "360000000100"',
        'section_id: "360000000010"',
        'locale: "en-us"',
        'created_at: "2026-01-02T03:04:05Z"',
        'updated_at: "2026-10-12T10:00:00Z"',
        "---",
        "",
        "# Reset a password",
        "",
        "- Zendesk: [Reset a password](https://acme.zendesk.com/hc/en-us/articles/360000000001-Reset-a-password)",
        "- Section: Accounts",
        "- Author: Sam Rivera",
        "- Labels: password, login",
        "",
        "## Steps",
        "",
        "Open **Settings** and select [Security](https://acme.zendesk.com/hc/en-us/articles/2).",
        "",
        "- One",
        "- Two",
        "",
        // An image is not copied in this version; the article link has it.
        "[Image: Settings screen]",
        "",
        "```",
        "npm run reset",
        "```",
        "",
        // A signed URL never reaches git.
        "Log: signed",
        "",
      ].join("\n"),
    )
  })
})

describe("zendeskTicketFile", () => {
  const file = zendeskTicketFile({ viewId: "900001", ticket })

  it("writes the ticket under its view", () => {
    expect(file.path).toBe("zendesk/tickets/views/900001/4501.md")
  })

  it("renders the ticket and its comments, with names only", () => {
    expect(file.content).toBe(
      [
        "---",
        'source: "zendesk"',
        'zendesk_id: "4501"',
        'url: "https://acme.zendesk.com/agent/tickets/4501"',
        'view_id: "900001"',
        'status: "open"',
        'priority: "high"',
        'created_at: "2026-10-10T09:00:00Z"',
        'updated_at: "2026-10-12T11:00:00Z"',
        "---",
        "",
        "# Ticket #4501: Export fails | large files",
        "",
        "- Zendesk: [#4501](https://acme.zendesk.com/agent/tickets/4501)",
        "- Status: open",
        "- Priority: high",
        "- Type: problem",
        "- Tags: export, bug",
        "- Requester: Alex Kim",
        "- Assignee: Sam Rivera",
        "",
        "## Comments",
        "",
        "### Alex Kim, 2026-10-10T09:00:00Z",
        "",
        "The export stops at 2 GB.",
        "",
        "See the attached log.",
        "",
        "Attachments (in Zendesk): export.log",
        "",
        "### Sam Rivera, 2026-10-11T10:00:00Z (internal note)",
        "",
        "Repro on staging. Linked to ENG-42.",
        "",
      ].join("\n"),
    )
  })
})
