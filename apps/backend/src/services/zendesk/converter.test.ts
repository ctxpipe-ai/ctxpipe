import { describe, expect, it } from "vitest"

import {
  redactTicketText,
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
    expect(content).toContain("# Ticket #4501: Refund for [email removed]")
    expect(content).toContain("- Requester: [email removed]")
    expect(content).toContain(
      "> Call me on [phone removed] or [phone removed] or [phone removed].",
    )
  })

  it("removes links that carry a credential, and keeps other text", () => {
    expect(content).not.toContain("abc123")
    expect(content).not.toContain("secretpath")
    expect(content).toContain("> Log: [link removed]")
    expect(content).toContain("Docs: https://help.example.com/reset")
    expect(content).toContain("Since 2026-10-12, on version 1.2.3.")
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
    expect(text(`Call ${phone} today`)).toContain("Call [phone removed] today")
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
    expect(content).toContain("Call [phone removed] today")
    expect(content).not.toContain(phone)
  })

  it("removes a number that follows a date, and keeps the date", () => {
    expect(text("On 2026-10-14 0412345678 called")).toContain(
      "On 2026-10-14 [phone removed] called",
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
      "[docs](https://help.example.com/a)",
    ],
    [
      "a Markdown link with brackets in its query",
      "[docs](https://help.example.com/a?a=(b)&token=SECRET)",
      "[docs](https://help.example.com/a)",
    ],
    [
      "a URL as the text of its own link",
      "[https://help.example.com/a?k=SECRET](https://help.example.com/a?k=SECRET)",
      "[https://help.example.com/a](https://help.example.com/a)",
    ],
    [
      "a URL in brackets at the end of a sentence",
      "(see https://help.example.com/b?q=SECRET).",
      "(see https://help.example.com/b).",
    ],
    ["a relative link", "[log](/files/log?k=SECRET)", "[log](/files/log)"],
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
    ["a javascript link", "[click](javascript:alert(SECRET1))"],
    ["a data link", "[img](data:text/html;base64,SECRET1)"],
  ])("keeps only the text of %s", (_name, link) => {
    expect(text(`See ${link}.`)).not.toContain("SECRET1")
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
    expect(lines).toContain("> &lt;script>x&lt;/script>")
  })

  it("adds no heading other than its own", () => {
    expect(lines.filter((line) => /^#{1,6}\s/.test(line))).toEqual([
      "# Ticket #4501: Help \\#\\# Fake heading &lt;img src=x onerror=alert(1)>",
      "## Comments",
      "### Alex \\#\\#\\# Agent, 2026-10-10T09:00:00Z",
    ])
  })

  it("escapes link syntax in names, tags, and attachment names", () => {
    expect(lines).toContain(
      "- Requester: \\[click\\](https://evil.example.com)",
    )
    expect(lines).toContain("- Assignee: Sam \\# Owner")
    expect(lines).toContain("- Tags: a\\]b, \\#tag")
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
      "# Ticket #4501: \\[link removed\\](https://evil.example.com) for [email removed]",
    )
  })

  it("keeps status, priority, and comment time on one escaped line", () => {
    expect(lines).toContain("- Status: open \\# Fake status")
    expect(lines).toContain(
      "- Priority: high \\[x\\](https://evil.example.com)",
    )
    expect(lines.filter((line) => /^#{1,6}\s/.test(line))).toEqual([
      "# Ticket #4501: \\[link removed\\](https://evil.example.com) for [email removed]",
      "## Comments",
      "### Alex Kim, 2026-10-10T09:00:00Z \\# Fake comment",
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
    expect(content).toContain("# Ticket #4501: Mail [email removed] abc")
    expect(content).toContain("> Mail [email removed] or [email removed]")
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

  /** The best of three runs, in milliseconds. */
  const best = (run: () => void) => {
    const times: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const start = performance.now()
      run()
      times.push(performance.now() - start)
    }
    return Math.min(...times)
  }

  // A linear pass takes four times as long on four times the input; a
  // quadratic one takes sixteen times. The floor keeps timer noise out.
  it.each([
    ["an address", (n: number) => "a".repeat(n)],
    ["dotted words", (n: number) => "a.".repeat(n / 2)],
    ["open brackets", (n: number) => "[".repeat(n)],
    ["links that never close", (n: number) => "[a](".repeat(n / 4)],
    ["www prefixes", (n: number) => "www.".repeat(n / 4)],
    ["scheme prefixes", (n: number) => "https://".repeat(n / 8)],
    ["link starts", (n: number) => "](".repeat(n / 2)],
    ["a query of end marks", (n: number) => `https://x?${")".repeat(n)}x`],
    ["a query of brackets", (n: number) => `https://x?${"]".repeat(n)}x`],
    ["blanks", (n: number) => `${" ".repeat(n)}x`],
    ["digits", (n: number) => `${"1".repeat(n)}a`],
    ["digit groups", (n: number) => `${"1 ".repeat(n / 2)}:`],
    ["code fences", (n: number) => "```a ".repeat(n / 5)],
  ])("redacts %s in linear time", (_name, make) => {
    const small = best(() => redactTicketText(make(32_768)))
    const large = best(() => redactTicketText(make(131_072)))
    expect(large / Math.max(small, 3)).toBeLessThan(9)
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
      "# Reset \\#\\# Fake heading \\[x\\](https://evil.example.com)",
    ])
  })

  it("keeps the section, the author, and the labels on one line each", () => {
    expect(lines).toContain("- Section: Accounts \\# Fake section")
    expect(lines).toContain("- Author: Sam \\#\\#\\# Fake author")
    expect(lines).toContain("- Labels: a \\# Fake label, b")
  })
})
