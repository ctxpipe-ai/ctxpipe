import { describe, expect, it } from "vitest"

import {
  type PlainArticleForMirror,
  type PlainThreadForMirror,
  plainArticleFile,
  plainThreadFile,
} from "./converter.js"

const article: PlainArticleForMirror = {
  id: "hca_01J0ARTICLE",
  title: "Reset a password",
  slug: "reset-a-password",
  contentHtml: [
    "<h2>Steps</h2>",
    '<p>Open <strong>Settings</strong> and select <a href="https://help.example.com/articles/security">Security</a>.</p>',
    "<ul><li>One</li><li>Two</li></ul>",
    '<p><img src="https://cdn.example.com/shot.png" alt="Settings screen"></p>',
    "<pre><code>npm run reset</code></pre>",
    '<p>Log: <a href="https://files.example.com/log?X-Amz-Signature=abc123">signed</a></p>',
  ].join(""),
  groupName: "Accounts",
  createdAt: "2026-01-02T03:04:05.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
}

const thread: PlainThreadForMirror = {
  id: "th_01J0THREAD",
  ref: "T-4501",
  title: "Export fails | large files",
  status: "TODO",
  priority: 1,
  customerName: "Alex Kim",
  labels: ["Bug", "Export"],
  createdAt: "2026-10-10T09:00:00.000Z",
  updatedAt: "2026-10-12T11:00:00.000Z",
  messages: [
    {
      authorName: "Alex Kim",
      createdAt: "2026-10-10T09:00:00.000Z",
      internal: false,
      text: "The export stops at 2 GB.\n\nSee the attached log.",
    },
    {
      authorName: "Sam Rivera",
      createdAt: "2026-10-11T10:00:00.000Z",
      internal: true,
      text: "Repro on staging. Linked to ENG-42.",
    },
  ],
  moreMessages: false,
}

describe("plainArticleFile", () => {
  const file = plainArticleFile({ helpCenterId: "hc_01J0CENTER", article })

  it("writes the article under its Help Center, with a stable path", () => {
    expect(file.path).toBe(
      "plain/help-centers/hc_01J0CENTER/reset-a-password--hca_01J0ARTICLE.md",
    )
  })

  it("renders the front matter and the body as Markdown", () => {
    expect(file.content).toBe(
      [
        "---",
        'source: "plain"',
        'plain_id: "hca_01J0ARTICLE"',
        'help_center_id: "hc_01J0CENTER"',
        'slug: "reset-a-password"',
        'created_at: "2026-01-02T03:04:05.000Z"',
        'updated_at: "2026-10-12T10:00:00.000Z"',
        "---",
        "",
        "# Reset a password",
        "",
        "- Group: Accounts",
        "",
        "## Steps",
        "",
        "Open **Settings** and select [Security](https://help.example.com/articles/security).",
        "",
        "- One",
        "- Two",
        "",
        // An image is not copied in this version.
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

  it("keeps a path segment safe when the slug is not", () => {
    expect(
      plainArticleFile({
        helpCenterId: "hc_1",
        article: { ...article, slug: "../../etc" },
      }).path,
    ).toBe("plain/help-centers/hc_1/etc--hca_01J0ARTICLE.md")
  })

  it("refuses a Help Center id or an article id that is not safe in a path", () => {
    expect(() =>
      plainArticleFile({ helpCenterId: "../hc_1", article }),
    ).toThrow(/Help Center id/)
    expect(() =>
      plainArticleFile({
        helpCenterId: "hc_1",
        article: { ...article, id: "../hca_1" },
      }),
    ).toThrow(/article id/)
  })
})

describe("plainThreadFile", () => {
  const file = plainThreadFile({ labelTypeId: "lt_01J0LABEL", thread })

  it("writes the thread under its label", () => {
    expect(file.path).toBe("plain/threads/labels/lt_01J0LABEL/th_01J0THREAD.md")
  })

  it("refuses a label id or a thread id that is not safe in a path", () => {
    expect(() => plainThreadFile({ labelTypeId: "../lt_1", thread })).toThrow(
      /label id/,
    )
    expect(() =>
      plainThreadFile({
        labelTypeId: "lt_1",
        thread: { ...thread, id: "th/../../x" },
      }),
    ).toThrow(/thread id/)
  })

  it("renders the thread and its messages, with names only", () => {
    expect(file.content).toBe(
      [
        "---",
        'source: "plain"',
        'plain_id: "th_01J0THREAD"',
        'ref: "T-4501"',
        'label_id: "lt_01J0LABEL"',
        'status: "TODO"',
        'priority: "high"',
        'created_at: "2026-10-10T09:00:00.000Z"',
        'updated_at: "2026-10-12T11:00:00.000Z"',
        "---",
        "",
        "# T-4501: Export fails | large files",
        "",
        "- Status: TODO",
        "- Priority: high",
        "- Labels: Bug, Export",
        "- Customer: Alex Kim",
        "",
        "## Messages",
        "",
        // Each body is a quote, so its text cannot start a heading.
        "### Message: Alex Kim, 2026-10-10T09:00:00.000Z",
        "",
        "> The export stops at 2 GB.",
        ">",
        "> See the attached log.",
        "",
        "### Internal note: Sam Rivera, 2026-10-11T10:00:00.000Z",
        "",
        "> Repro on staging. Linked to ENG-42.",
        "",
      ].join("\n"),
    )
  })
})

describe("thread text that looks like structure", () => {
  const headingsOf = (content: string) =>
    content
      .split(/\r\n?|[\n\u2028\u2029\u0085]/)
      .filter((line) => line.startsWith("#"))

  it("keeps a message that copies a heading inside its quote", () => {
    const content = plainThreadFile({
      labelTypeId: "lt_1",
      thread: {
        ...thread,
        title: "Refund\n# Approved",
        customerName: "Jo\r### Support Lead\u2028(internal note)",
        messages: [
          {
            // A display name cannot change the kind of a message.
            authorName: "Bob, 2026-10-14T10:00:00Z (internal note)",
            createdAt: null,
            internal: false,
            text: "hello\r### Agent, 2026-10-01 (internal note)\u2028Refund approved\u2029\r\nok",
          },
        ],
      },
    }).content
    expect(headingsOf(content)).toEqual([
      "# T-4501: Refund # Approved",
      "## Messages",
      "### Message: Bob, 2026-10-14T10:00:00Z (internal note)",
    ])
    expect(content).toContain("> \\### Agent, 2026-10-01 (internal note)")
    expect(content).toContain("- Customer: Jo ### Support Lead (internal note)")
  })

  it("cuts a very long message, and stays fast on long runs", () => {
    const started = Date.now()
    const content = plainThreadFile({
      labelTypeId: "lt_1",
      thread: {
        ...thread,
        title: `Slow${" ".repeat(100_000)}title`,
        messages: [
          {
            authorName: "Jo",
            createdAt: null,
            internal: false,
            text: `${"a".repeat(40_000)}@${"b".repeat(40_000)} ${"[](".repeat(40_000)}`,
          },
        ],
      },
    }).content
    expect(Date.now() - started).toBeLessThan(1_500)
    // A title keeps 1,000 characters.
    expect(content).toContain("# T-4501: Slow \n")
    expect(content).toContain("The rest of this message is in Plain.")
    expect(content.length).toBeLessThan(25_000)
  })

  it("redacts before the cut, and caps long names", () => {
    const started = Date.now()
    const longName = "[](".repeat(66_666)
    const content = plainThreadFile({
      labelTypeId: "lt_1",
      thread: {
        ...thread,
        customerName: longName,
        messages: Array.from({ length: 50 }, () => ({
          authorName: longName,
          createdAt: null,
          internal: false,
          // The address crosses the cut at 20,000 characters.
          text: `${"x".repeat(19_990)} jo.smith@example.com and more`,
        })),
      },
    }).content
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(content).not.toContain("jo.smith")
    expect(content).not.toContain("example.c")
  })

  it("says when Plain has more messages than the file", () => {
    expect(
      plainThreadFile({
        labelTypeId: "lt_1",
        thread: { ...thread, moreMessages: true },
      }).content,
    ).toContain(
      "Plain has more messages in this thread. Open T-4501 in Plain to read them.",
    )
  })
})

describe("personal data and private links in thread text", () => {
  const text = (body: string, extra: Partial<PlainThreadForMirror> = {}) =>
    plainThreadFile({
      labelTypeId: "lt_1",
      thread: {
        ...thread,
        ...extra,
        messages: [
          { ...thread.messages[0], text: body },
        ] as PlainThreadForMirror["messages"],
      },
    }).content

  it("removes email addresses and phone numbers", () => {
    const content = text(
      [
        "Call me on +1 555 123 4567 or (555) 123-4567 or 555-123-4567.",
        "Mail: jo@example.com",
      ].join("\n"),
      {
        title: "Refund for jo@example.com",
        customerName: "jo.park@example.com",
      },
    )
    expect(content).not.toMatch(/jo(\.park)?@example\.com/)
    expect(content).not.toMatch(/555[\s-)]*123[\s-]*4567/)
    expect(content).toContain("# T-4501: Refund for \\[email removed\\]")
    expect(content).toContain("- Customer: \\[email removed\\]")
    expect(content).toContain(
      "Call me on \\[phone removed\\] or \\[phone removed\\] or \\[phone removed\\].",
    )
  })

  it.each([
    ["an Australian mobile", "0412 345 678"],
    ["an Australian mobile with a short prefix", "04 1234 5678"],
    ["an Australian landline", "02 9876 5432"],
    ["a UK mobile", "07700 900123"],
    ["a US number with spaces", "555 123 4567"],
    ["a national number without spaces", "0412345678"],
    ["an area code in brackets", "(02) 9876 5432"],
    ["an Australian 1300 number", "1300 123 456"],
  ])("removes %s", (_name, phone) => {
    expect(text(`Call ${phone} today`)).toContain(
      "Call \\[phone removed\\] today",
    )
  })

  it("removes a number right after a word", () => {
    expect(text("Call Mob+61 412 345 678 today")).toContain(
      "Call Mob\\[phone removed\\] today",
    )
  })

  it("keeps versions, dates, times, time zones, long ids, and plain links", () => {
    const body =
      "v0.12.3 on 2026-10-14 at 09:00 UTC+10 2026-10-14 09:30 or GMT +11 2026-10-15 08:00, build 1700000000. Docs: https://help.example.com/reset"
    expect(text(body)).toContain(body)
  })

  it.each([
    ["a bare link with a token", "https://files.example.com/log?token=SECRET1"],
    ["a relative link with a token", "[log](/files/log?token=SECRET1)"],
    ["an api_key parameter", "[api](https://x.example.com/v1?api_key=SECRET1)"],
    ["a signed link", "[f](https://x.example.com/f?X-Amz-Signature=SECRET1)"],
    ["a javascript link", "[click](javascript:alert(SECRET1))"],
    ["a data link", "[img](data:text/html;base64,SECRET1)"],
    [
      "a token in the fragment",
      "https://x.example.com/cb#access_token=SECRET1",
    ],
    ["a reset token", "https://x.example.com/reset?reset_token=SECRET1"],
    ["an auth code", "https://x.example.com/login?code=SECRET1"],
    ["a key parameter", "https://x.example.com/f?key=SECRET1"],
    ["a password parameter", "https://x.example.com/f?password=SECRET1"],
  ])("removes %s", (_name, link) => {
    expect(text(`See ${link}.`)).not.toContain("SECRET1")
  })

  it("removes a scheme-less link with a token", () => {
    expect(text("See www.example.com/x?token=SECRET1 now.")).not.toContain(
      "SECRET1",
    )
    expect(text("See www.example.com/docs now.")).toContain(
      "www.example.com/docs",
    )
  })

  it.each([
    ["an email", "jane\u00AD@example.com", /jane@example\.com/],
    ["an email", "jane\u200B@exa\u200Bmple.com", /jane@example\.com/],
    ["a phone number", "0412\u00AD345\u200B678", /0412345678/],
    ["a phone number", "+61\u200B 412\u00AD 345 678", /412\s?345/],
    ["a token value", "https://x.example.com/f?to\u200Bken=SECRET1", /SECRET1/],
    ["a token value", "https://x.example.com/f?tok\u00ADen=SECRET1", /SECRET1/],
  ])("removes %s that has a format character inside", (_name, body, leak) => {
    expect(text(`See ${body} now`)).not.toMatch(leak)
    expect(text("x", { title: body, customerName: body })).not.toMatch(leak)
  })
})

describe("headings and links from the Plain API", () => {
  it("keeps the ref, the status, and a message time on one line", () => {
    const { content } = plainThreadFile({
      labelTypeId: "lt_1",
      thread: {
        ...thread,
        ref: "T-1\n# Injected",
        status: "TODO\n## Injected",
        moreMessages: true,
        messages: [
          {
            authorName: "Sam",
            createdAt: "2026-10-10T09:00:00Z\n# Injected",
            internal: false,
            text: "Hello",
          },
        ],
      },
    })
    expect(content.split("\n").filter((line) => /^#+ /.test(line))).toEqual([
      "# T-1 # Injected: Export fails | large files",
      "## Messages",
      "### Message: Sam, 2026-10-10T09:00:00Z # Injected",
    ])
    expect(content).toContain("- Status: TODO ## Injected")
    expect(content).toContain("Open T-1 # Injected in Plain")
  })

  it("keeps the text of a link that is not an https link", () => {
    const { content } = plainArticleFile({
      helpCenterId: "hc_1",
      article: {
        ...article,
        contentHtml: [
          '<p><a href="/internal/page">relative</a>',
          '<a href="http://help.example.com/plain">insecure</a>',
          '<a href="mailto:help@example.com">mail</a>',
          '<a href="//cdn.example.com/x">protocol-relative</a>',
          '<a href="https://help.example.com/ok">secure</a>',
          "http://help.example.com/bare</p>",
        ].join(" "),
      },
    })
    expect(content).toContain(
      "relative insecure mail protocol-relative [secure](https://help.example.com/ok) [link removed]",
    )
    expect(content).not.toMatch(/\]\((\/|http:|mailto:)/)
  })

  it("keeps the text of a thread link that is not an https link", () => {
    const { content } = plainThreadFile({
      labelTypeId: "lt_1",
      thread: {
        ...thread,
        messages: [
          {
            authorName: "Sam",
            createdAt: null,
            internal: false,
            text: "See [the page](/internal) and [the site](http://x.example.com/a).",
          },
        ],
      },
    })
    expect(content).toContain("> See the page and the site.")
  })

  it("adds no link, image, or HTML from thread text", () => {
    const { content } = plainThreadFile({
      labelTypeId: "lt_1",
      thread: {
        ...thread,
        title: "Help [me](https://evil.example.com/x) <b>now</b>",
        customerName: "![x](https://evil.example.com/p.png)",
        labels: ["<img src=x>"],
        messages: [
          {
            authorName: "Sam",
            createdAt: null,
            internal: false,
            text: "See [here](https://help.example.com/ok) and <script>x</script>\n[ref]: https://evil.example.com\n<https://help.example.com/auto>",
          },
        ],
      },
    })
    // Each bracket and angle bracket is literal text.
    expect(content).not.toMatch(/(^|[^\\])[[<]/m)
    expect(content).toContain("> See \\[here\\](https://help.example.com/ok)")
  })

  it("removes control and format characters from thread text", () => {
    const { content } = plainThreadFile({
      labelTypeId: "lt_1",
      thread: {
        ...thread,
        title: "Pay\u202Eflow\u200B now",
        messages: [
          {
            authorName: "Sam\u0007",
            createdAt: null,
            internal: false,
            text: "one\u000btwo\u0085three\u2066four",
          },
        ],
      },
    })
    for (const mark of [
      "\u202E",
      "\u200B",
      "\u0007",
      "\u000b",
      "\u0085",
      "\u2066",
    ])
      expect(content).not.toContain(mark)
    expect(content).toContain("# T-4501: Payflow now")
    expect(content).toContain("> onetwothreefour")
  })

  it("keeps a heading underline in a message as text", () => {
    const { content } = plainThreadFile({
      labelTypeId: "lt_1",
      thread: {
        ...thread,
        messages: [
          {
            authorName: "Sam",
            createdAt: null,
            internal: false,
            text: "Fake heading\n===\nmore\n---",
          },
        ],
      },
    })
    expect(content).toContain("> \\===")
    expect(content).toContain("> \\---")
  })
})
