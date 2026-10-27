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
  const file = zendeskArticleFile({
    subdomain: "acme",
    categoryId: "360000000100",
    article,
  })

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
        // The query of a signed URL never reaches git.
        "Log: [signed](https://files.example.com/log)",
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
        "> The export stops at 2 GB.",
        ">",
        "> See the attached log.",
        "",
        "Attachments (in Zendesk): export.log",
        "",
        "### Sam Rivera, 2026-10-11T10:00:00Z (internal note)",
        "",
        "> Repro on staging. Linked to ENG-42.",
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
    expect(content).toContain("# Ticket #4501: Refund for \\[email removed\\]")
    expect(content).toContain("- Requester: \\[email removed\\]")
    expect(content).toContain(
      "> Call me on \\[phone removed\\] or \\[phone removed\\] or \\[phone removed\\].",
    )
  })

  it("removes links that carry a credential, and keeps other text", () => {
    expect(content).not.toContain("abc123")
    expect(content).not.toContain("secretpath")
    expect(content).toContain("> Log: https://files.example.com/log")
    expect(content).toContain("Docs: https://help.example.com/reset")
    expect(content).toContain("Since 2026-10-12, on version 1.2.3.")
  })
})

describe("image alt text in article bodies", () => {
  it("writes an alt text with link syntax as inert text", () => {
    const { content } = zendeskArticleFile({
      subdomain: "acme",
      categoryId: "1",
      article: {
        ...article,
        bodyHtml:
          '<p><img src="https://x.example.com/a.png" alt="x](javascript:alert(1)) [y"></p>',
      },
    })
    expect(content).toContain("[Image: x\\](javascript:alert(1)) \\[y]")
  })
})

describe("private links in article bodies", () => {
  const body = (bodyHtml: string) =>
    zendeskArticleFile({
      subdomain: "acme",
      categoryId: "1",
      article: { ...article, bodyHtml },
    }).content

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
    expect(text(`Call ${phone} today`)).toContain(
      "Call \\[phone removed\\] today",
    )
  })

  it.each([
    ["a mobile without spaces", "0412345678"],
    ["a UK mobile without spaces", "07700900123"],
    ["a US number without spaces", "5551234567"],
    ["a landline with a bracketed area code", "(02) 9876 5432"],
    ["a short local number", "555-1234"],
    ["an international number with a bracketed zero", "+61 (0)412 345 678"],
    ["an international number with dots", "+44.7700.900.123"],
  ])("removes %s", (_name, phone) => {
    const content = text(`Call ${phone} today`)
    expect(content).toContain("Call \\[phone removed\\] today")
    expect(content).not.toContain(phone)
  })

  it("removes a number that follows a date, and keeps the date", () => {
    expect(text("On 2026-10-14 0412345678 called")).toContain(
      "On 2026-10-14 \\[phone removed\\] called",
    )
  })

  it("keeps versions, dates, times, ticket references, and long ids", () => {
    const body = [
      "v0.12.3 on 2026-10-14 at 09:00, ticket 4501, see #4501234567.",
      "Since 2026-10-14 09:00 and 2026-10-14T09:00:00Z and 14.10.2026 09:00.",
      "Run `2.0.20261014` or `10.15.7.123456`; trace 12345678901234567890.",
    ].join("\n")
    for (const line of body.split("\n")) expect(text(body)).toContain(line)
  })

  it("keeps a ticket id in the heading and the link", () => {
    const content = zendeskTicketFile({
      viewId: "1",
      ticket: {
        ...ticket,
        id: "4501234567",
        url: "https://acme.zendesk.com/agent/tickets/4501234567",
      },
    }).content
    expect(content).toContain("# Ticket #4501234567: ")
    expect(content).toContain(
      "- Zendesk: [#4501234567](https://acme.zendesk.com/agent/tickets/4501234567)",
    )
  })

  it.each([
    [
      "a query with brackets",
      "https://x.example.com/a?a=(b)&token=SECRET",
      "https://x.example.com/a",
    ],
    [
      "a query with a name that no list has",
      "https://x.example.com/a?session=SECRET",
      "https://x.example.com/a",
    ],
    [
      "a fragment",
      "https://x.example.com/a#access=SECRET",
      "https://x.example.com/a",
    ],
    [
      "a Markdown link with a query",
      "[docs](https://help.example.com/a?ref=SECRET)",
      "\\[docs\\](https://help.example.com/a)",
    ],
    [
      "a Markdown link with brackets in its query",
      "[docs](https://help.example.com/a?a=(b)&token=SECRET)",
      "\\[docs\\](https://help.example.com/a)",
    ],
    [
      "a URL as the text of its own link",
      "[https://help.example.com/a?k=SECRET](https://help.example.com/a?k=SECRET)",
      "\\[https://help.example.com/a\\](https://help.example.com/a)",
    ],
    [
      "a URL in brackets at the end of a sentence",
      "(see https://help.example.com/b?q=SECRET).",
      "(see https://help.example.com/b).",
    ],
    ["a relative link", "[log](/files/log?k=SECRET)", "\\[log\\](/files/log)"],
    [
      "a link without a scheme",
      "www.example.com/a?k=SECRET",
      "www.example.com/a",
    ],
  ])("removes the query of %s", (_name, url, kept) => {
    const content = text(`See ${url} now`)
    expect(content).not.toContain("SECRET")
    expect(content).toContain(`See ${kept} now`)
  })

  it("keeps a path with brackets", () => {
    expect(text("See https://en.wikipedia.org/wiki/Foo_(bar) now")).toContain(
      "See https://en.wikipedia.org/wiki/Foo_(bar) now",
    )
  })

  it.each([
    ["a relative link with a token", "[log](/files/log?token=SECRET1)"],
    ["an api_key parameter", "[api](https://x.example.com/v1?api_key=SECRET1)"],
  ])("keeps only the text of %s", (_name, link) => {
    expect(text(`See ${link}.`)).not.toContain("SECRET1")
  })

  it.each([
    // oxlint-disable-next-line no-script-url -- the case is a hostile link
    ["a javascript link", "click", "javascript:alert(1)"],
    ["a data link", "img", "data:text/html;base64,AAAA"],
  ])("writes %s as inert text", (_name, label, target) => {
    const content = text(`See [${label}](${target}).`)
    expect(content).toContain(`See \\[${label}\\](${target}).`)
    expect(content).not.toMatch(new RegExp(`(?<!\\\\)\\[${label}\\]\\(`))
  })
})

describe("customer text cannot change the structure of a ticket file", () => {
  const spoofed = zendeskTicketFile({
    viewId: "1",
    ticket: {
      ...ticket,
      subject: "Help\n## Fake heading <img src=x onerror=alert(1)>",
      requesterName: "[click](https://evil.example.com)",
      assigneeName: "Sam\n# Owner",
      tags: ["a]b", "#tag"],
      comments: [
        {
          authorName: "Alex\n### Agent",
          createdAt: "2026-10-10T09:00:00Z",
          public: true,
          body: [
            "Thanks",
            "### Agent Sam, 2026-10-11T10:00:00Z (internal note)",
            "Refund approved",
            "Fake heading",
            "===",
            "<script>x</script>",
          ].join("\n"),
          attachments: ["[a](https://evil.example.com).pdf"],
        },
      ],
    },
  }).content
  const lines = spoofed.split("\n")

  it("puts every line of a comment body in a quote", () => {
    expect(lines).toContain("> Thanks")
    expect(lines).toContain(
      "> \\### Agent Sam, 2026-10-11T10:00:00Z (internal note)",
    )
    expect(lines).toContain("> Refund approved")
    expect(lines).toContain("> \\===")
    expect(lines).toContain("> \\<script\\>x\\</script\\>")
  })

  it("adds no heading other than its own", () => {
    expect(lines.filter((line) => /^#{1,6}\s/.test(line))).toEqual([
      "# Ticket #4501: Help ## Fake heading \\<img src=x onerror=alert(1)\\>",
      "## Comments",
      "### Alex ### Agent, 2026-10-10T09:00:00Z",
    ])
  })

  it("escapes link syntax in names, tags, and attachment names", () => {
    expect(lines).toContain(
      "- Requester: \\[click\\](https://evil.example.com)",
    )
    expect(lines).toContain("- Assignee: Sam # Owner")
    expect(lines).toContain("- Tags: a\\]b, #tag")
    expect(lines).toContain(
      "Attachments (in Zendesk): \\[a\\](https://evil.example.com).pdf",
    )
  })
})

describe("provider links in article files", () => {
  const file = (url: string, bodyHtml = "<p>Body</p>") =>
    zendeskArticleFile({
      subdomain: "acme",
      categoryId: "1",
      article: { ...article, url, bodyHtml },
    }).content

  it.each([
    ["another host", "https://evil.example.com/hc/articles/1"],
    ["a look-alike host", "https://acme.zendesk.com.evil.example.com/a"],
    ["another account", "https://other.zendesk.com/hc/articles/1"],
    ["http", "http://acme.zendesk.com/hc/articles/1"],
    // oxlint-disable-next-line no-script-url -- the case is a hostile link
    ["a script link", "javascript:alert(1)"],
  ])("keeps only the title for a link to %s", (_name, url) => {
    const content = file(url)
    expect(content).not.toContain(url)
    expect(content).not.toContain("url:")
    expect(content).toContain("- Zendesk: Reset a password\n")
  })

  it("encodes a bracket in the article link", () => {
    expect(file("https://acme.zendesk.com/hc/articles/1-a_(b)")).toContain(
      "- Zendesk: [Reset a password](https://acme.zendesk.com/hc/articles/1-a_%28b%29)",
    )
  })

  it("keeps only the text of a body link that is not https", () => {
    const content = file(
      "https://acme.zendesk.com/hc/articles/1",
      '<p><a href="http://plain.example.com/a">plain</a> and <a href="mailto:x@example.com">mail</a> and <a href="https://help.example.com/a">safe</a></p>',
    )
    expect(content).not.toContain("plain.example.com")
    expect(content).not.toContain("mailto:")
    expect(content).toContain(
      "plain and mail and [safe](https://help.example.com/a)",
    )
  })
})

describe("provider fields and typed markers in one-line text", () => {
  const content = zendeskTicketFile({
    viewId: "1",
    ticket: {
      ...ticket,
      subject: "[link removed](https://evil.example.com) for jo@example.com",
      status: "open\n# Fake status",
      priority: "high [x](https://evil.example.com)",
      comments: [
        {
          authorName: "Alex Kim",
          createdAt: "2026-10-10T09:00:00Z\n# Fake comment",
          public: true,
          body: "Hi",
          attachments: [],
        },
      ],
    },
  }).content
  const lines = content.split("\n")

  it("escapes a redaction marker that the customer typed as a link", () => {
    expect(lines).toContain(
      "# Ticket #4501: \\[link removed\\](https://evil.example.com) for \\[email removed\\]",
    )
  })

  it("keeps status, priority, and comment time on one escaped line", () => {
    expect(lines).toContain("- Status: open # Fake status")
    expect(lines).toContain(
      "- Priority: high \\[x\\](https://evil.example.com)",
    )
    expect(lines.filter((line) => /^#{1,6}\s/.test(line))).toEqual([
      "# Ticket #4501: \\[link removed\\](https://evil.example.com) for \\[email removed\\]",
      "## Comments",
      "### Alex Kim, 2026-10-10T09:00:00Z # Fake comment",
    ])
  })
})

describe("format characters in customer text", () => {
  it("removes them before the redaction, so they cannot hide an email address", () => {
    const content = zendeskTicketFile({
      viewId: "1",
      ticket: {
        ...ticket,
        subject: "Mail jo\u200b@example.com \u202eabc",
        comments: [
          {
            authorName: "Alex Kim",
            createdAt: "2026-10-10T09:00:00Z",
            public: true,
            body: "Mail jo\u200b@example.com or \u2066sam@example.org\u2069",
            attachments: [],
          },
        ],
      },
    }).content

    expect(content).not.toMatch(/[\u200b\u202e\u2066\u2069]/)
    expect(content).not.toContain("@example")
    expect(content).toContain("# Ticket #4501: Mail \\[email removed\\] abc")
    expect(content).toContain(
      "> Mail \\[email removed\\] or \\[email removed\\]",
    )
  })
})

describe("line breaks and control characters in customer text", () => {
  const ticketWith = (body: string, authorName = "Alex Kim") =>
    zendeskTicketFile({
      viewId: "1",
      ticket: {
        ...ticket,
        comments: [
          {
            authorName,
            createdAt: "2026-10-10T09:00:00Z",
            public: true,
            body,
            attachments: [],
          },
        ],
      },
    }).content
  /** The line ends of CommonMark, and the two that other renderers use. */
  const linesOf = (content: string) => content.split(/\r\n|[\r\n\u2028\u2029]/)

  it.each([
    ["a lone carriage return", "\r"],
    ["a carriage return and a line feed", "\r\n"],
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
    ["a vertical tab", "\u000b"],
    ["a form feed", "\u000c"],
    ["a next line (U+0085)", "\u0085"],
  ])("does not let %s end the quote", (_name, lineBreak) => {
    const content = ticketWith(
      `Thanks${lineBreak}### Agent Sam, 2026-10-11T10:00:00Z (internal note)${lineBreak}Refund approved${lineBreak}Fake${lineBreak}===`,
    )
    for (const mark of ["\u2028", "\u2029", "\u000b", "\u000c", "\u0085"])
      expect(content).not.toContain(mark)
    expect(content).not.toMatch(/\r(?!\n)/)
    expect(linesOf(content).filter((line) => /^#{1,6}\s/.test(line))).toEqual([
      "# Ticket #4501: Export fails | large files",
      "## Comments",
      "### Alex Kim, 2026-10-10T09:00:00Z",
    ])
    expect(linesOf(content).filter((line) => /^=+$/.test(line))).toEqual([])
    expect(content).toContain("Refund approved")
  })

  it("keeps a lone carriage return in an author name on one line", () => {
    const content = ticketWith("Hi", "Alex\r### Agent Sam (internal note)")
    expect(
      linesOf(content).filter((line) => /^#{1,6}\s/.test(line)),
    ).toHaveLength(3)
  })
})

describe("size and cost of customer text", () => {
  const body = (text: string) =>
    zendeskTicketFile({
      viewId: "1",
      ticket: {
        ...ticket,
        comments: [
          {
            authorName: "Alex",
            createdAt: null,
            public: true,
            body: text,
            attachments: [],
          },
        ],
      },
    }).content

  it("cuts a long comment and marks it", () => {
    const content = body("word ".repeat(40_000))
    expect(content.length).toBeLessThan(20_000)
    expect(content).toContain("> [comment truncated]")
  })

  it("does not keep the start of an address that the cut splits", () => {
    const content = body(`${"x ".repeat(8190)}jo.park@example.com tail`)
    expect(content).not.toContain("jo.park")
  })

  it("does not mark a short comment", () => {
    expect(body("Short")).not.toContain("truncated")
  })
})

describe("provider ids in paths", () => {
  it("refuses an article id that is not a number", () => {
    expect(() =>
      zendeskArticleFile({
        subdomain: "acme",
        categoryId: "1",
        article: { ...article, id: "../x" },
      }),
    ).toThrow(/article id/)
  })

  it("refuses a ticket id that is not a number", () => {
    expect(() =>
      zendeskTicketFile({ viewId: "1", ticket: { ...ticket, id: "../x" } }),
    ).toThrow(/ticket id/)
  })
})

describe("one-line fields of an article file", () => {
  const lines = zendeskArticleFile({
    subdomain: "acme",
    categoryId: "1",
    article: {
      ...article,
      title: "Reset\r## Fake heading\n[x](https://evil.example.com)",
      sectionName: "Accounts\n# Fake section",
      authorName: "Sam\u2028### Fake author",
      labels: ["a\n# Fake label", "b"],
      // The body can have its own headings; this test is about the fields.
      bodyHtml: "",
    },
  }).content.split(/\r\n|[\r\n\u2028\u2029]/)

  it("adds no heading other than the title", () => {
    expect(lines.filter((line) => /^#{1,6}\s/.test(line))).toEqual([
      "# Reset ## Fake heading \\[x\\](https://evil.example.com)",
    ])
  })

  it("keeps the section, the author, and the labels on one line each", () => {
    expect(lines).toContain("- Section: Accounts # Fake section")
    expect(lines).toContain("- Author: Sam ### Fake author")
    expect(lines).toContain("- Labels: a # Fake label, b")
  })
})

describe("security re-review: probes on the real file functions", () => {
  const ticketOf = (
    text: string,
    fields: Partial<ZendeskTicketForMirror> = {},
  ) =>
    zendeskTicketFile({
      viewId: "1",
      ticket: {
        ...ticket,
        comments: [
          {
            authorName: "Alex",
            createdAt: null,
            public: true,
            body: text,
            attachments: [],
          },
        ],
        ...fields,
      },
    }).content
  const articleOf = (fields: Partial<ZendeskArticleForMirror>) =>
    zendeskArticleFile({
      subdomain: "acme",
      categoryId: "1",
      article: { ...article, ...fields },
    }).content

  describe("invisible characters", () => {
    const invisible = [
      "️",
      "\u{e0100}",
      "᠋",
      "ᅟ",
      "ᅠ",
      "ㅤ",
      "ﾠ",
      "឴",
      "͏",
      "​",
      "⁠",
      "﻿",
    ]

    it.each(
      invisible.map(
        (mark) =>
          [mark.codePointAt(0)?.toString(16).toUpperCase(), mark] as const,
      ),
    )(
      "does not let U+%s hide an email address or a phone number",
      (_code, mark) => {
        const text = `Mail jo.smith${mark}@example.com or call +61${mark} 412 345 678`
        for (const content of [
          ticketOf(text),
          ticketOf("x", { subject: text }),
          ticketOf("x", { requesterName: text }),
        ]) {
          expect(content).not.toContain("jo.smith")
          expect(content).not.toContain("@example")
          expect(content).not.toMatch(/412\D*345\D*678/)
        }
      },
    )

    it("keeps a combining accent", () => {
      expect(ticketOf("cafe\u0301 menu")).toContain("> caf\u00e9 menu")
    })
  })

  describe("a length cut after the redaction made the text shorter", () => {
    const address = "jo.smith@example.com"
    // A run with no space leaves the cut at the hard limit, so sweep the
    // address over it.
    it.each([
      ["a comment", 16 * 1024, (text: string) => ticketOf(text)],
      [
        "a subject",
        2 * 1024,
        (text: string) => ticketOf("x", { subject: text }),
      ],
    ])("keeps no fragment of an address in %s", (_name, max, render) => {
      for (const filler of ["(", "<a>"]) {
        for (let shift = 0; shift <= address.length + 2; shift += 1) {
          const start = max - shift
          const text = `${filler.repeat(Math.ceil(start / filler.length)).slice(0, start)}${address}${"z".repeat(max)}`
          const content = render(text)
          expect(content).not.toMatch(/jo\.smith|@example|smith@/)
        }
      }
    })

    it("keeps no fragment after long credential links", () => {
      const link = `https://f.example.com/${"p".repeat(300)}?token=SECRET2`
      for (let shift = 0; shift <= address.length + 2; shift += 1) {
        const links = `<${link}>`.repeat(
          Math.floor((16 * 1024) / (link.length + 2)),
        )
        const pad = "<".repeat(Math.max(0, 16 * 1024 - shift - links.length))
        const content = ticketOf(`${links}${pad}${address}${"z".repeat(600)}`)
        expect(content).not.toMatch(/jo\.smith|@example|smith@|SECRET2/)
      }
    })
  })

  describe("a URL query that a character entity hides", () => {
    it.each(["&apos;", "&quot;", "&amp;", "&lt;", "&gt;", "&#39;"])(
      "removes the query after %s",
      (entity) => {
        const content = ticketOf(
          `See https://f.example.com/a${entity}?token=SECRET4 and https://f.example.com/b${entity}?x=SECRET4B`,
        )
        expect(content).not.toContain("SECRET4")
      },
    )
  })

  describe("www after a Markdown mark", () => {
    it.each(["_", "*", "~", "(", "[", '"', "'", ">"])(
      "removes the query of www. after %s",
      (mark) => {
        const content = ticketOf(
          `${mark}www.f.example.com/l?token=SECRET3_ ${mark}www.f.example.com/m?x=SECRET3B${mark}`,
        )
        expect(content).not.toContain("SECRET3")
      },
    )
  })

  describe("scheme case", () => {
    it.each([
      "HTTPS://f.example.com/l?token=SECRET5",
      "hTTpS://f.example.com/l?token=SECRET5",
      "HTTP://f.example.com/l?token=SECRET5",
      "WWW.f.example.com/l?token=SECRET5",
      "wWw.f.example.com/l?x=SECRET5",
      "[a](HTTPS://f.example.com/l?token=SECRET5)",
      "<HTTPS://f.example.com/l?token=SECRET5>",
    ])("removes the query of %s", (text) => {
      expect(ticketOf(text)).not.toContain("SECRET5")
      expect(ticketOf("x", { subject: text })).not.toContain("SECRET5")
    })
  })

  describe("the article path", () => {
    it("removes a credential parameter with a zero-width space", () => {
      const content = articleOf({
        bodyHtml:
          '<p>See <a href="https://f.example.com/l?to​ken=SECRET7">file</a> and https://f.example.com/m?to​ken=SECRET7</p>',
      })
      expect(content).not.toContain("SECRET7")
    })

    it("removes a credential URL in the title", () => {
      const content = articleOf({
        title: "Get https://f.example.com/l?token=SECRET8 now",
      })
      expect(content).not.toContain("SECRET8")
    })

    it("removes an email address and a phone number in the title and the body", () => {
      const content = articleOf({
        title: "Write jo.smith@example.com",
        bodyHtml: "<p>Call +61 412 345 678 or jo.smith@example.com</p>",
      })
      expect(content).not.toContain("jo.smith")
      expect(content).not.toMatch(/412\D*345\D*678/)
    })

    it("removes the query of a plain URL in the body", () => {
      const content = articleOf({
        bodyHtml: "<p>Open https://f.example.com/l?code=SECRET9</p>",
      })
      expect(content).not.toContain("SECRET9")
    })
  })

  describe("round two: Unicode spaces and full-width characters", () => {
    it.each([
      ["a no-break space", "Tel +61\u00A0412\u00A0345\u00A0678", /412|345|678/],
      [
        "a narrow no-break space",
        "Tel 06\u202F12\u202F34\u202F56\u202F78",
        /12\D*34\D*56/,
      ],
      ["a thin space", "Tel 555\u2009123\u20094567", /555|123|4567/],
      ["a tab", "Tel 555\t123\t4567", /555|123|4567/],
      ["two spaces", "Tel 555  123  4567", /555|123|4567/],
      ["full-width digits", "Tel ０９０-１２３４-５６７８", /１２３４|1234/],
      ["a full-width at sign", "Mail jo.smith＠example.com", /smith|example/],
      ["a small commercial at", "Mail jo﹫x.com", /x\.com/],
      ["a one dot leader", "Mail jo@example\u2024com", /example/],
    ])("removes a contact detail with %s", (_name, text, leak) => {
      expect(ticketOf(text)).not.toMatch(leak)
      expect(ticketOf("x", { subject: text })).not.toMatch(leak)
    })
  })

  describe("round two: a dotted phone number", () => {
    it("removes a French number and keeps dotted dates", () => {
      const content = ticketOf("Tel 01.23.45.67.89 on 14.10.2026")
      expect(content).not.toMatch(/23\.45/)
      expect(content).toContain("14.10.2026")
    })
  })

  describe("round two: a cut inside a phone number", () => {
    const phones = [
      ["call +1 555 123 4567", /555|123|4567/],
      ["call +61 412 345 678", /412|345|678/],
    ] as const
    it.each(phones)(
      "keeps no part of a phone number after %s",
      (text, leak) => {
        for (const [max, render] of [
          [16 * 1024, (value: string) => ticketOf(value)],
          [2 * 1024, (value: string) => ticketOf("x", { subject: value })],
        ] as const) {
          for (let shift = 0; shift <= text.length + 1; shift += 1) {
            const start = max - shift
            const lead = `${"x ".repeat(Math.ceil(start / 2))}`.slice(
              0,
              start - 1,
            )
            expect(render(`${lead} ${text} ${"y ".repeat(40)}`)).not.toMatch(
              leak,
            )
          }
        }
      },
    )
  })

  describe("round two: a URL with no scheme", () => {
    it.each([
      "Open app.example.com/reset?code=SECRET1",
      "Open //cdn.example.com/f.pdf?code=SECRET1",
      "Open 1www.example.com/r?code=SECRET1",
    ])("removes the query of %s", (text) => {
      expect(ticketOf(text)).not.toContain("SECRET1")
      expect(ticketOf("x", { subject: text })).not.toContain("SECRET1")
    })

    it.each([
      "postgres://admin:hunter2@10.0.0.5:5432/app",
      "redis://:hunter2@localhost:6379",
      "mongodb+srv://u:hunter2!@cluster0.example.net/db",
    ])("removes the credentials of %s", (text) => {
      expect(ticketOf(`Use ${text} now`)).not.toContain("hunter2")
      expect(ticketOf("x", { subject: text })).not.toContain("hunter2")
    })
  })

  describe("round two: adjacent links", () => {
    it("keeps two links apart when each has a query", () => {
      const content = articleOf({
        bodyHtml:
          '<p><a href="https://a.com/one?x=1">one</a><a href="https://b.com/two?y=2">two</a></p>',
      })
      expect(content).toContain(
        "[one](https://a.com/one)[two](https://b.com/two)",
      )
    })
  })

  describe("round two: the article slug", () => {
    it("builds the slug from the title as written", () => {
      const file = zendeskArticleFile({
        subdomain: "acme",
        categoryId: "1",
        article: { ...article, title: "A < B" },
      })
      expect(file.path).toMatch(/\/a-b--360000000001\.md$/)
    })
  })

  describe("final security check: text that NFKC would damage", () => {
    it.each(["ㅋㅋㅋ ㅠㅠ", "3½ m"])("keeps %s in a comment", (text) => {
      expect(ticketOf(`Note ${text} end`)).toContain(`Note ${text} end`)
    })

    it("keeps compatibility jamo and fractions in an article title", () => {
      const content = articleOf({ title: "ㅋㅋㅋ ㅠㅠ 3½" })
      expect(content).toContain("ㅋㅋㅋ ㅠㅠ 3½")
    })

    it("still folds full-width digits and a no-break space", () => {
      expect(ticketOf("Tel ０９０-１２３４-５６７８ ㅋ")).not.toMatch(
        /1234|１２３４/,
      )
      expect(ticketOf("a\u00A0b")).toContain("a b")
    })
  })

  describe("final security check: a // that is not a URL", () => {
    it("keeps a #region marker in text and in a code block", () => {
      expect(ticketOf("//#region setup")).toContain("//#region setup")
      const content = articleOf({
        bodyHtml: "<pre><code>//#region setup</code></pre>",
      })
      expect(content).toContain("//#region setup")
    })

    it("still removes the query of a scheme-relative URL", () => {
      expect(
        ticketOf("Open //cdn.example.com/f.pdf?sig=SECRET1"),
      ).not.toContain("SECRET1")
    })
  })

  describe("round two: text with no space", () => {
    it("keeps the start of a long CJK comment", () => {
      const content = ticketOf("你好世界".repeat(4200))
      expect(content).toContain("你好世界")
      expect(content).toContain("> [comment truncated]")
    })

    it("keeps the start of a long CJK subject", () => {
      const content = ticketOf("x", { subject: "你好世界".repeat(600) })
      expect(content).toContain("你好世界")
    })
  })
})
