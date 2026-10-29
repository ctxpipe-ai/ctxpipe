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
        "\\[Image: Settings screen\\]",
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
    // A title is cut, and the cut drops the spaces at its end.
    // The collapse of the spaces runs before the cut.
    expect(content).toContain("# T-4501: Slow title\n")
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

  it("keeps versions, dates, times, time zones, and plain links", () => {
    const body =
      "v0.12.3 on 2026-10-14 at 09:00 UTC+10 2026-10-14 09:30 or GMT +11 2026-10-15 08:00. Docs: https://help.example.com/reset"
    expect(text(body)).toContain(body)
  })

  it("removes a long number that looks like a phone number", () => {
    // The shared phone rule counts 9 to 15 digits, so a Unix time goes too.
    expect(text("build 1700000000 done")).toContain(
      "build \\[phone removed\\] done",
    )
  })

  it.each([
    ["a bare link with a token", "https://files.example.com/log?token=SECRET1"],
    ["a relative link with a token", "[log](/files/log?token=SECRET1)"],
    ["an api_key parameter", "[api](https://x.example.com/v1?api_key=SECRET1)"],
    ["a signed link", "[f](https://x.example.com/f?X-Amz-Signature=SECRET1)"],
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

  it.each([
    ["a javascript link", "[click](javascript:alert(1))"],
    ["a data link", "[img](data:text/html;base64,AAAA)"],
  ])("leaves %s as text that is not a link", (_name, link) => {
    const content = text(`See ${link}.`)
    // The brackets are escaped, so a viewer shows no link.
    expect(content).toContain(`See ${link.replace(/\[(\w+)\]/, "\\[$1\\]")}.`)
    expect(content).not.toMatch(/(^|[^\\])\[\w+\]\(/m)
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
  it("leaves no live link in the alt text of an article image", () => {
    const { content } = plainArticleFile({
      helpCenterId: "hc_1",
      article: {
        ...article,
        contentHtml:
          '<p><img src="x.png" alt="x](javascript:alert(1)) [y"></p>',
      },
    })
    expect(content).toContain("\\[Image: x\\](javascript:alert(1)) \\[y\\]")
    expect(content).not.toMatch(/(^|[^\\])\]\(javascript/m)
  })

  it("leaves no live link when text that starts with a bracket follows an image", () => {
    const { content } = plainArticleFile({
      helpCenterId: "hc_1",
      article: {
        ...article,
        contentHtml: '<p><img src="x.png" alt="x">(javascript:alert(1))</p>',
      },
    })
    expect(content).not.toMatch(/(^|[^\\])\]\(javascript/m)
  })

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
      "relative insecure mail protocol-relative [secure](https://help.example.com/ok) \\[link removed\\]",
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
    // The links stay as escaped text, with the host and the path.
    expect(content).toContain(
      "> See \\[the page\\](/internal) and \\[the site\\](http://x.example.com/a).",
    )
    expect(content).not.toMatch(/(^|[^\\])\[the/m)
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

describe("redaction gaps found in re-review (CTX-869)", () => {
  const render = (over: Partial<PlainThreadForMirror>) =>
    plainThreadFile({ labelTypeId: "lt_1", thread: { ...thread, ...over } })
      .content

  it("strips invisible characters before the message length cut", () => {
    // 100,000 characters of format marks, then an address: the strip must
    // run before the 100,000-character slice.
    const content = render({
      messages: [
        {
          authorName: null,
          createdAt: null,
          internal: false,
          text: `${"​".repeat(99_990)}jo.smith@example.com ${"x".repeat(30)}`,
        },
      ],
    })
    expect(content).not.toContain("jo.smith")
  })

  it("redacts a title before its 1,000-character cut", () => {
    const content = render({
      title: `${"x".repeat(985)} jo.smith@example.com`,
    })
    expect(content).not.toContain("jo.smith")
    expect(content).not.toContain("example.c")
  })

  it("filters an upper-case HTTPS link that has a token", () => {
    const content = render({
      messages: [
        {
          authorName: null,
          createdAt: null,
          internal: false,
          text: "Open HTTPS://files.example.com/log?token=abc123secret now",
        },
      ],
    })
    expect(content).not.toContain("abc123secret")
  })

  it("strips the combining grapheme joiner inside an address", () => {
    const content = render({
      messages: [
        {
          authorName: null,
          createdAt: null,
          internal: false,
          text: "Write to jo.smith͏@example.com please",
        },
      ],
    })
    expect(content).not.toContain("jo.smith")
  })
})

describe("redaction gaps found in a security re-review, round two (CTX-869)", () => {
  const render = (over: Partial<PlainThreadForMirror>) =>
    plainThreadFile({ labelTypeId: "lt_1", thread: { ...thread, ...over } })
      .content
  const body = (text: string) =>
    render({
      messages: [{ authorName: null, createdAt: null, internal: false, text }],
    })
  const articleContent = (over: Partial<PlainArticleForMirror>) =>
    plainArticleFile({
      helpCenterId: "hc_1",
      article: { ...article, ...over },
    }).content

  it.each([
    ["U+FE0F", "️"],
    ["U+E0100", "\u{E0100}"],
    ["U+180B", "᠋"],
    ["U+115F", "ᅟ"],
    ["U+1160", "ᅠ"],
    ["U+3164", "ㅤ"],
    ["U+FFA0", "ﾠ"],
    ["U+17B4", "឴"],
  ])("strips %s inside an address and a phone number", (_name, mark) => {
    const email = `jo.smith${mark}@example.com`
    const phone = `+61${mark} 412 345 678`
    const content = body(`Mail ${email} or call ${phone} now`)
    expect(content).not.toContain("jo.smith")
    expect(content).not.toContain("412")
    const titled = render({ title: email, customerName: phone })
    expect(titled).not.toContain("jo.smith")
    expect(titled).not.toContain("412")
  })

  it("keeps a combining accent", () => {
    expect(body("cafe\u0301 open")).toContain("caf\u00e9 open")
  })

  describe("a cut at 100,000 characters", () => {
    // Credential links of 2,000 characters become short stubs, so the later
    // cuts do not reach the tail. The address starts 9 characters before
    // character 100,000.
    const links = (total: number) => {
      let out = ""
      while (out.length < total - 2_100)
        out += `https://f.example.com/a?token=${"x".repeat(1_970)} `
      const rest = total - out.length
      return `${out}https://f.example.com/a?token=${"x".repeat(rest - 31)} `
    }
    const straddle = `${links(99_991)}jo.smith@example.com tail`

    it("does not leave a part of an address in a message body", () => {
      expect(body(straddle)).not.toContain("jo.smith")
    })

    it("does not leave a part of an address in a title or a name", () => {
      // The title cut is 4,000 characters. Short credential links become
      // stubs, so the address still starts inside the 1,000-character result.
      let text = ""
      while (text.length < 3_800)
        text += `https://f.example.com/a?token=${"x".repeat(70)} `
      const rest = 3_991 - text.length
      text += `https://f.example.com/a?token=${"x".repeat(rest - 31)} `
      const titled = `${text}jo.smith@example.com tail`
      const content = render({ title: titled, customerName: titled })
      expect(content).not.toContain("jo.smith")
    })
  })

  it.each([
    ["an apostrophe", "https://f.example.com/a'?token=SECRET4"],
    ["a double quote", 'https://f.example.com/a"?token=SECRET4'],
  ])("removes a link that has %s before its token", (_name, link) => {
    expect(body(`See ${link} now`)).not.toContain("SECRET4")
  })

  it("keeps a link in quotes, apart from the redaction", () => {
    expect(body('See "https://help.example.com/a" now')).toContain(
      '"https://help.example.com/a"',
    )
    expect(body(`See "https://f.example.com/a?token=SECRET4" now`)).toContain(
      '"https://f.example.com/a"',
    )
    expect(body("See 'https://f.example.com/a?token=SECRET4' now")).toContain(
      "'https://f.example.com/a'",
    )
  })

  it.each(["_", "*", "~", "("])("removes a www link after %s", (lead) => {
    const content = body(`See ${lead}www.f.example.com/l?token=SECRET3_ now`)
    expect(content).not.toContain("SECRET3")
  })

  it("removes a hidden token in an article body", () => {
    const content = articleContent({
      contentHtml: "<p>https://f.example.com/a?to​ken=SECRET7</p>",
    })
    expect(content).not.toContain("SECRET7")
  })

  it("removes a credential link in an article title and group", () => {
    const content = articleContent({
      title: "See https://f.example.com/a?token=SECRET8",
      groupName: "Group https://f.example.com/a?token=SECRET9",
    })
    expect(content).not.toContain("SECRET8")
    expect(content).not.toContain("SECRET9")
  })

  it("redacts in linear time", () => {
    const start = performance.now()
    body(`${"a".repeat(5_000_000)}`)
    body("https://".repeat(600_000))
    body(`${"️".repeat(5_000_000)}`)
    body("a=b&".repeat(1_000_000))
    body("x://".repeat(1_000_000))
    body(`${"a".repeat(2_000_000)}@`)
    body(`?${"k".repeat(2_000_000)}`)
    expect(performance.now() - start).toBeLessThan(5_000)
  })
})

describe("redaction gaps found in a security re-review, round three (CTX-869)", () => {
  const render = (over: Partial<PlainThreadForMirror>) =>
    plainThreadFile({ labelTypeId: "lt_1", thread: { ...thread, ...over } })
      .content
  const body = (text: string) =>
    render({
      messages: [{ authorName: null, createdAt: null, internal: false, text }],
    })
  const articleContent = (over: Partial<PlainArticleForMirror>) =>
    plainArticleFile({
      helpCenterId: "hc_1",
      article: { ...article, ...over },
    }).content

  it.each([
    ["postgres://admin:hunter2@10.0.0.5:5432/app", "hunter2"],
    ["redis://:hunter2@localhost:6379", "hunter2"],
    ["mongodb+srv://u:p4ss!@cluster0.example.net/db", "p4ss"],
    ["files.example.com/log?token=SECRET1", "SECRET1"],
    ["wwww.example.com/?token=SECRET2", "SECRET2"],
  ])("removes the credential in %s", (link, secret) => {
    expect(body(`See ${link} now`)).not.toContain(secret)
    const titled = render({ title: link, customerName: link })
    expect(titled).not.toContain(secret)
    expect(
      articleContent({ title: link, contentHtml: `<p>${link}</p>` }),
    ).not.toContain(secret)
  })

  it("keeps a normal link and normal text with an equals sign", () => {
    const content = body(
      "See https://example.com/a?lang=en and a=b and k=v&x=1",
    )
    // The shared rule removes every query, so no name list is needed.
    expect(content).toContain("https://example.com/a and")
    expect(content).not.toContain("lang=en")
    expect(content).toContain("a=b and k=v&x=1")
  })

  it.each([
    ["a space", "https://x.example.com/a b?token=SECRETS"],
    ["a tab", "https://x.example.com/a\tb?token=SECRETS"],
  ])("removes an article link whose href has %s", (_name, href) => {
    const content = articleContent({
      contentHtml: `<p><a href="${href}">label</a></p>`,
    })
    expect(content).not.toContain("SECRETS")
    expect(content).toContain("label")
  })

  it("keeps an article link that may stay", () => {
    const content = articleContent({
      contentHtml: '<p><a href="https://help.example.com/a">label</a></p>',
    })
    expect(content).toContain("[label](https://help.example.com/a)")
  })

  it.each([
    ["a no-break space", "555\u00A0123\u00A04567", "555"],
    ["an en dash", "555\u2013123\u20134567", "555"],
    ["a national number", "0412\u00A0345\u00A0678", "0412"],
  ])("removes a phone number with %s", (_name, phone, start) => {
    expect(body(`Call ${phone} now`)).not.toContain(start)
    expect(render({ title: phone })).not.toContain(start)
  })

  it("keeps a date and a version", () => {
    const content = body("On 2026-10-27 we shipped 1.2.3 today")
    expect(content).toContain("2026-10-27")
    expect(content).toContain("1.2.3")
  })

  it("keeps text when a long message has no space", () => {
    expect(body("あ".repeat(120_000))).toContain("あああ")
  })

  it("leaves no digit of a phone number that a cut splits", () => {
    // The 1,000-character cut falls inside the number, after a space.
    const titled = render({ title: `${"a".repeat(985)} call 0412 345 678 now` })
    expect(titled).not.toMatch(/0412|345/)
    expect(titled).toContain(" call…")
  })

  it.each([
    ["full-width digits", "Tel ０９０-１２３４-５６７８", "１２３４", "1234"],
    [
      "a full-width at sign",
      "Mail jo.smith＠example.com",
      "jo.smith",
      "jo.smith",
    ],
    ["a small at sign", "Mail jo.smith﹫example.com", "jo.smith", "jo.smith"],
    ["a French number", "Tel 06 12 34 56 78", "56 78", "34 56"],
  ])("removes %s after NFKC", (_name, text, a, b) => {
    const content = body(text)
    expect(content).not.toContain(a)
    expect(content).not.toContain(b)
    const titled = render({ title: text, customerName: text })
    expect(titled).not.toContain(a)
    expect(titled).not.toContain(b)
  })

  it("encodes a newline in an article link href", () => {
    const content = articleContent({
      contentHtml:
        '<p><a href="https://a.example/x&#10;&#10;# Injected heading&#10;&#10;![p](https://track.example/p.png">t</a></p>',
    })
    expect(content).not.toMatch(/^# Injected/m)
    expect(content).not.toContain("![p](")
  })

  it("encodes a parenthesis in an article link href", () => {
    const content = articleContent({
      contentHtml:
        '<p><a href="https://a.example/x)![i](https://track.example/p.png">t</a></p>',
    })
    expect(content).not.toContain("![i](")
    expect(content).toContain("%29")
  })

  it("leaves no part of an address when a cut has no space to walk back to", () => {
    const customerName = `http://${"b".repeat(1_946)}<http://${"a".repeat(2_025)}<jo.smith@example.com tail`
    // The 4,000-character cut falls inside the address.
    const titled = render({ customerName })
    expect(titled).not.toContain("jo.smith")
  })

  it("keeps Korean jamo and fractions", () => {
    const text = "ㅋㅋㅋ ㅠㅠ 3½ m²"
    expect(body(text)).toContain("ㅋㅋㅋ ㅠㅠ 3½ m2")
    expect(render({ title: text })).toContain("ㅋㅋㅋ ㅠㅠ 3½ m2")
  })
})
