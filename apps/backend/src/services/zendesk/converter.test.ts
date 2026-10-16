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

describe("personal data and private links in ticket text", () => {
  const leaky: ZendeskTicketForMirror = {
    ...ticket,
    subject: "Refund for jo@example.com",
    requesterName: "jo.park@example.com",
    comments: [
      {
        authorName: "Jo Park",
        createdAt: "2026-10-10T09:00:00Z",
        public: true,
        body: [
          "Call me on +1 555 123 4567 or (555) 123-4567 or 555-123-4567.",
          "Mail: jo@example.com",
          "Log: https://files.example.com/log?token=abc123",
          "Shot: https://acme.zendesk.com/attachments/token/secretpath/?name=a.png",
          "Docs: https://help.example.com/reset",
          "Since 2026-10-12, on version 1.2.3.",
        ].join("\n"),
        attachments: ["jo@example.com.pdf"],
      },
    ],
  }
  const content = zendeskTicketFile({ viewId: "900001", ticket: leaky }).content

  it("removes email addresses and phone numbers", () => {
    expect(content).not.toMatch(/jo(\.park)?@example\.com/)
    expect(content).not.toMatch(/555[\s-)]*123[\s-]*4567/)
    expect(content).toContain("# Ticket #4501: Refund for [email removed]")
    expect(content).toContain("- Requester: [email removed]")
    expect(content).toContain(
      "Call me on [phone removed] or [phone removed] or [phone removed].",
    )
  })

  it("removes links that carry a credential, and keeps other text", () => {
    expect(content).not.toContain("abc123")
    expect(content).not.toContain("secretpath")
    expect(content).toContain("Log: [link removed]")
    expect(content).toContain("Docs: https://help.example.com/reset")
    expect(content).toContain("Since 2026-10-12, on version 1.2.3.")
  })
})

describe("private links in article bodies", () => {
  const body = (bodyHtml: string) =>
    zendeskArticleFile({ categoryId: "1", article: { ...article, bodyHtml } })
      .content

  it.each([
    [
      "a link with a title",
      '<a href="https://x.example.com/f?X-Amz-Signature=s1" title="t">file</a>',
    ],
    [
      "a link whose text is the URL",
      '<a href="https://x.example.com/f?token=s1">https://x.example.com/f?token=s1</a>',
    ],
    [
      "a Zendesk attachment link",
      '<a href="https://acme.zendesk.com/attachments/token/s1/?name=a.png">a.png</a>',
    ],
  ])("keeps only the text of %s", (_name, html) => {
    expect(body(`<p>${html}</p>`)).not.toContain("s1")
  })
})

describe("more personal data and link forms", () => {
  const text = (body: string) =>
    zendeskTicketFile({
      viewId: "1",
      ticket: {
        ...ticket,
        comments: [
          {
            ...ticket.comments[0],
            body,
          } as ZendeskTicketForMirror["comments"][number],
        ],
      },
    }).content

  it.each([
    ["an Australian mobile", "0412 345 678"],
    ["an Australian mobile with a short prefix", "04 1234 5678"],
    ["an Australian landline", "02 9876 5432"],
    ["a UK mobile", "07700 900123"],
    ["a US number with spaces", "555 123 4567"],
  ])("removes %s", (_name, phone) => {
    expect(text(`Call ${phone} today`)).toContain("Call [phone removed] today")
  })

  it("keeps versions, dates, times, and long ids", () => {
    const body = "v0.12.3 on 2026-10-14 at 09:00, build 1700000000, ticket 4501"
    expect(text(body)).toContain(body)
  })

  it.each([
    ["a relative link with a token", "[log](/files/log?token=SECRET1)"],
    ["an api_key parameter", "[api](https://x.example.com/v1?api_key=SECRET1)"],
    ["a javascript link", "[click](javascript:alert(SECRET1))"],
    ["a data link", "[img](data:text/html;base64,SECRET1)"],
  ])("keeps only the text of %s", (_name, link) => {
    expect(text(`See ${link}.`)).not.toContain("SECRET1")
  })
})
