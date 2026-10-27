import { describe, expect, it } from "vitest"

import {
  type ArticlePolicy,
  articleText,
  customerLine,
  customerText,
  safeHref,
} from "./customer-text.js"

const body = (text: string) => customerText(text, { maxChars: 20_000 }).text
const line = (text: string) => customerLine(text, { maxChars: 2_000 })

describe("strip at entry", () => {
  it.each([
    ["U+200B", "\u200b"],
    ["U+2060", "\u2060"],
    ["U+FEFF", "\ufeff"],
    ["U+FE0F", "\ufe0f"],
    ["U+E0100", "\u{e0100}"],
    ["U+180B", "\u180b"],
    ["U+115F", "\u115f"],
    ["U+1160", "\u1160"],
    ["U+3164", "\u3164"],
    ["U+FFA0", "\uffa0"],
    ["U+17B4", "\u17b4"],
    ["U+034F", "\u034f"],
    ["U+00AD", "\u00ad"],
  ])(
    "does not let %s hide an email address or a phone number",
    (_code, mark) => {
      const text = `Mail jo.smith${mark}@example.com or call +61${mark} 412 345 678`
      for (const out of [body(text), line(text)]) {
        expect(out).not.toContain("jo.smith")
        expect(out).not.toContain("@example")
        expect(out).not.toMatch(/412\D*345\D*678/)
        expect(out).not.toContain(mark)
      }
    },
  )

  it("removes bidi, zero-width, and control characters", () => {
    expect(line("Pay\u202Eflow\u200B now\u0007")).toBe("Payflow now")
    expect(body("one\u000btwo\u0085three\u2066four\u000cfive")).toBe(
      "onetwothreefourfive",
    )
  })

  it("strips before the cut, so that marks cannot push an address past it", () => {
    const { text } = customerText(
      `${"\u200b".repeat(99_990)}jo.smith@example.com ${"x".repeat(30)}`,
      { maxChars: 100 },
    )
    expect(text).not.toContain("jo.smith")
  })

  it("keeps a combining accent, composed by NFKC", () => {
    expect(body("cafe\u0301 menu")).toBe("caf\u00e9 menu")
  })
})

describe("NFKC", () => {
  it.each([
    ["a no-break space", "Tel +61\u00A0412\u00A0345\u00A0678", /412|345|678/],
    [
      "a narrow no-break space",
      "Tel 06\u202F12\u202F34\u202F56\u202F78",
      /12\D*34\D*56/,
    ],
    ["a thin space", "Tel 555\u2009123\u20094567", /555|123|4567/],
    ["full-width digits", "Tel ０９０-１２３４-５６７８", /１２３４|1234/],
    ["a full-width at sign", "Mail jo.smith＠example.com", /smith|example/],
    ["a small commercial at", "Mail jo﹫x.com", /x\.com/],
    ["a one dot leader", "Mail jo@example\u2024com", /example/],
  ])("removes a contact detail with %s", (_name, text, leak) => {
    expect(body(text)).not.toMatch(leak)
    expect(line(text)).not.toMatch(leak)
  })

  it.each(["ㅋㅋㅋ ㅠㅠ", "3½ m", "¼ ¾ ⅐ ⅟ ↉"])(
    "keeps %s, which NFKC would change",
    (text) => {
      expect(body(`Note ${text} end`)).toBe(`Note ${text} end`)
      expect(line(`Note ${text} end`)).toBe(`Note ${text} end`)
    },
  )

  it("still folds other compatibility characters", () => {
    expect(body("m² a\u00A0b ﬁle")).toBe("m2 a b file")
  })

  it("does not fold a full-width bracket into a live Markdown mark", () => {
    expect(body("［x］（https://evil.example.com）＜b＞")).toBe(
      "［x］(https://evil.example.com)＜b＞",
    )
  })
})

describe("one-line fields", () => {
  it.each([
    ["a line feed", "\n"],
    ["a carriage return", "\r"],
    ["CR LF", "\r\n"],
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
    ["a tab", "\t"],
    ["a vertical tab", "\u000b"],
    ["a next line (U+0085)", "\u0085"],
  ])("keeps a field with %s on one line", (_name, br) => {
    const out = line(`Help${br}## Fake heading${br}${br}more`)
    expect(out).not.toMatch(/[\p{Cc}\u2028\u2029]/u)
    expect(out).toMatch(/^Help ?## Fake heading ?more$/)
  })

  it("collapses line breaks before the redaction", () => {
    expect(line("Call 0412\n345\t678 now")).toBe("Call \\[phone removed\\] now")
    expect(line("Call 555\r\n123\r\n4567")).toBe("Call \\[phone removed\\]")
  })
})

describe("no live Markdown from customer text", () => {
  it("escapes link, image, and HTML marks", () => {
    expect(
      line(
        "Help [me](https://evil.example.com/x) ![p](https://evil.example.com/p.png) <b>now</b>",
      ),
    ).toBe(
      "Help \\[me\\](https://evil.example.com/x) !\\[p\\](https://evil.example.com/p.png) \\<b\\>now\\</b\\>",
    )
    expect(body("[ref]: https://evil.example.com\n<script>x</script>")).toBe(
      "\\[ref\\]: https://evil.example.com\n\\<script\\>x\\</script\\>",
    )
  })

  it("escapes a backslash only before a mark it could cancel", () => {
    expect(line("C:\\Users\\jo \\[x]")).toBe("C:\\Users\\jo \\\\\\[x\\]")
  })

  it("leaves no unescaped bracket or angle bracket", () => {
    const out = body(
      "See [here](https://help.example.com/ok) and <script>x</script>\n[ref]: https://evil.example.com\n<https://help.example.com/auto>",
    )
    expect(out).not.toMatch(/(^|[^\\])[[\]<>]/m)
  })

  it("escapes a marker that the customer typed, so that it cannot be a link", () => {
    expect(
      line("[link removed](https://evil.example.com) for jo@example.com"),
    ).toBe(
      "\\[link removed\\](https://evil.example.com) for \\[email removed\\]",
    )
  })

  it("escapes a marker that the helper writes once, not twice", () => {
    expect(body("Mail jo@example.com(https://evil.example.com)")).toBe(
      "Mail \\[email removed\\](https://evil.example.com)",
    )
    // A typed marker and a written marker look the same.
    expect(body("[email removed] or jo@example.com")).toBe(
      "\\[email removed\\] or \\[email removed\\]",
    )
  })

  it("gives only line feeds as line ends in a body", () => {
    expect(body("a\r\nb\rc\u2028d\u2029e")).toBe("a\nb\nc\nd\ne")
  })
})

describe("emails", () => {
  it.each([
    ["an ASCII address", "jo.park@example.com"],
    ["an accented local part", "josé@example.com"],
    ["a Cyrillic look-alike in the domain", "jo@exаmple.com"],
    ["a full-width at sign", "jo.smith＠example.com"],
    ["a combining mark in the local part", "jo.smith̀@example.com"],
    ["a Unicode domain", "jo@bücher.example"],
  ])("removes %s", (_name, address) => {
    expect(body(`Mail ${address} today`)).toBe("Mail \\[email removed\\] today")
    expect(line(`Refund for ${address}`)).toBe("Refund for \\[email removed\\]")
  })

  it("removes an address in an attachment name", () => {
    expect(line("jo@example.com.pdf")).toBe("\\[email removed\\]")
  })

  it("takes the letters next to an address in text with no spaces", () => {
    // The known cost of Unicode local parts.
    expect(body("请联系jo@example.com谢谢")).toBe("\\[email removed\\]")
  })

  it("keeps an at sign that is not in an address", () => {
    expect(body("Ping @sam at 9 @ the desk")).toBe("Ping @sam at 9 @ the desk")
  })
})

describe("phones", () => {
  it.each([
    ["an Australian mobile", "0412 345 678"],
    ["an Australian mobile with a short prefix", "04 1234 5678"],
    ["an Australian landline", "02 9876 5432"],
    ["a UK mobile", "07700 900123"],
    ["a US number with spaces", "555 123 4567"],
    ["a US number with brackets", "(555) 123-4567"],
    ["a US number with dashes", "555-123-4567"],
    ["an international US number", "+1 555 123 4567"],
    ["a mobile without spaces", "0412345678"],
    ["a UK mobile without spaces", "07700900123"],
    ["a US number without separators", "5551234567"],
    ["a country code without a plus", "61 412 345 678"],
    ["a landline with a bracketed area code", "(02) 9876 5432"],
    ["a short local number", "555-1234"],
    ["an international number with a bracketed zero", "+61 (0)412 345 678"],
    ["an international number with dots", "+44.7700.900.123"],
    ["an Australian 1300 number", "1300 123 456"],
    ["a French number with spaces", "06 12 34 56 78"],
    ["a French number with dots", "01.23.45.67.89"],
    ["a number with tabs", "555\t123\t4567"],
    ["a number with two spaces", "555  123  4567"],
    ["a number with a no-break space", "555 123 4567"],
    ["a number with an en dash", "555–123–4567"],
    ["a national number with a no-break space", "0412 345 678"],
    ["full-width digits", "０９０-１２３４-５６７８"],
  ])("removes %s", (_name, phone) => {
    expect(body(`Call ${phone} today`)).toBe("Call \\[phone removed\\] today")
    expect(line(`Call ${phone} today`)).toBe("Call \\[phone removed\\] today")
  })

  it("removes a number right after a word", () => {
    expect(body("Call Mob+61 412 345 678 today")).toBe(
      "Call Mob\\[phone removed\\] today",
    )
  })

  it("removes a number that follows a date, and keeps the date", () => {
    expect(body("On 2026-10-14 0412345678 called")).toBe(
      "On 2026-10-14 \\[phone removed\\] called",
    )
  })

  it("removes a French number and keeps dotted dates", () => {
    expect(body("Tel 01.23.45.67.89 on 14.10.2026")).toBe(
      "Tel \\[phone removed\\] on 14.10.2026",
    )
  })

  it("keeps versions, dates, times, time zones, ticket references, and long ids", () => {
    const text = [
      "v0.12.3 on 2026-10-14 at 09:00, ticket 4501, see #4501234567.",
      "Since 2026-10-14 09:00 and 2026-10-14T09:00:00Z and 14.10.2026 09:00 and 14/10/2026.",
      "Run `2.0.20261014` or `10.15.7.123456`; trace 12345678901234567890.",
      "At 09:00 UTC+10 2026-10-14 09:30 or GMT +11 2026-10-15 08:00.",
      "Versions v1.2.3 and 1.10.2026.1 shipped; we shipped 1.2.3 today.",
    ].join("\n")
    expect(body(text)).toBe(text)
  })

  it.each([
    ["an order number", "Order 123456789 shipped"],
    ["a Unix time", "build 1700000000 failed"],
  ])("removes %s too (the known cost of the digit count)", (_name, text) => {
    expect(body(text)).toContain("\\[phone removed\\]")
  })

  it("removes a phone number in a body with the other forms", () => {
    expect(
      body("Call me on +1 555 123 4567 or (555) 123-4567 or 555-123-4567."),
    ).toBe(
      "Call me on \\[phone removed\\] or \\[phone removed\\] or \\[phone removed\\].",
    )
  })
})

describe("URLs", () => {
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
      "a normal query",
      "https://example.com/a?lang=SECRET",
      "https://example.com/a",
    ],
    [
      "a fragment",
      "https://x.example.com/a#access=SECRET",
      "https://x.example.com/a",
    ],
    [
      "a token in the fragment",
      "https://x.example.com/cb#access_token=SECRET",
      "https://x.example.com/cb",
    ],
    [
      "a bare link with a token",
      "https://files.example.com/log?token=SECRET",
      "https://files.example.com/log",
    ],
    [
      "a signed link",
      "https://x.example.com/f?X-Amz-Signature=SECRET",
      "https://x.example.com/f",
    ],
    [
      "a reset token",
      "https://x.example.com/reset?reset_token=SECRET",
      "https://x.example.com/reset",
    ],
    [
      "an auth code",
      "https://x.example.com/login?code=SECRET",
      "https://x.example.com/login",
    ],
    [
      "a key parameter",
      "https://x.example.com/f?key=SECRET",
      "https://x.example.com/f",
    ],
    [
      "a password parameter",
      "https://x.example.com/f?password=SECRET",
      "https://x.example.com/f",
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
      "an api_key parameter in a Markdown link",
      "[api](https://x.example.com/v1?api_key=SECRET)",
      "\\[api\\](https://x.example.com/v1)",
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
      "a relative link with a token",
      "[log](/files/log?token=SECRET)",
      "\\[log\\](/files/log)",
    ],
    ["a www link", "www.example.com/a?k=SECRET", "www.example.com/a"],
    [
      "a www link with a token",
      "www.example.com/x?token=SECRET",
      "www.example.com/x",
    ],
    [
      "a link with no scheme",
      "app.example.com/reset?code=SECRET",
      "app.example.com/reset",
    ],
    [
      "a link with no scheme and a token",
      "files.example.com/log?token=SECRET",
      "files.example.com/log",
    ],
    [
      "a scheme-relative link",
      "//cdn.example.com/f.pdf?sig=SECRET",
      "//cdn.example.com/f.pdf",
    ],
    [
      "a www link after a digit",
      "1www.example.com/r?code=SECRET",
      "1www.example.com/r",
    ],
    ["four w", "wwww.example.com/?token=SECRET", "wwww.example.com/"],
    [
      "a link after dots",
      "...https://x.example.com/a?session=SECRET",
      "...https://x.example.com/a",
    ],
    [
      "a link after a digit",
      "1https://x.example.com/a?session=SECRET",
      "1https://x.example.com/a",
    ],
    [
      "a link after a dash",
      "-https://x.example.com/a?session=SECRET",
      "-https://x.example.com/a",
    ],
    [
      "a link with an apostrophe before its query",
      "https://f.example.com/a'?token=SECRET",
      "https://f.example.com/a'",
    ],
    [
      "a link with a double quote before its query",
      'https://f.example.com/a"?token=SECRET',
      'https://f.example.com/a"',
    ],
    [
      "a link in double quotes",
      '"https://f.example.com/a?token=SECRET"',
      '"https://f.example.com/a"',
    ],
    [
      "a link in single quotes",
      "'https://f.example.com/a?token=SECRET'",
      "'https://f.example.com/a'",
    ],
    [
      "a link in angle brackets",
      "<https://f.example.com/a?token=SECRET>",
      "\\<https://f.example.com/a\\>",
    ],
    [
      "an http link",
      "http://x.example.com/a?session=SECRET",
      "http://x.example.com/a",
    ],
  ])("removes the query of %s", (_name, url, kept) => {
    for (const out of [body(`See ${url} now`), line(`See ${url} now`)]) {
      expect(out).not.toContain("SECRET")
      expect(out).toBe(`See ${kept} now`)
    }
  })

  it.each([
    "HTTPS://f.example.com/l?token=SECRET",
    "hTTpS://f.example.com/l?token=SECRET",
    "HTTP://f.example.com/l?token=SECRET",
    "WWW.f.example.com/l?token=SECRET",
    "wWw.f.example.com/l?x=SECRET",
    "[a](HTTPS://f.example.com/l?token=SECRET)",
    "<HTTPS://f.example.com/l?token=SECRET>",
  ])("removes the query of %s, whatever the case", (text) => {
    expect(body(text)).not.toContain("SECRET")
    expect(line(text)).not.toContain("SECRET")
  })

  it.each(["&apos;", "&quot;", "&amp;", "&lt;", "&gt;", "&#39;"])(
    "removes the query after %s",
    (entity) => {
      expect(
        body(
          `See https://f.example.com/a${entity}?token=SECRET and https://f.example.com/b${entity}?x=SECRET`,
        ),
      ).not.toContain("SECRET")
    },
  )

  it.each(["_", "*", "~", "(", "[", '"', "'", ">"])(
    "removes the query of www. after %s",
    (mark) => {
      expect(
        body(
          `${mark}www.f.example.com/l?token=SECRET_ ${mark}www.f.example.com/m?x=SECRET${mark}`,
        ),
      ).not.toContain("SECRET")
    },
  )

  it.each([
    ["a zero-width space", "https://x.example.com/f?to\u200Bken=SECRET"],
    ["a soft hyphen", "https://x.example.com/f?tok\u00ADen=SECRET"],
  ])("removes a query with %s in it", (_name, url) => {
    expect(body(`See ${url} now`)).not.toContain("SECRET")
    expect(line(url)).not.toContain("SECRET")
  })

  it("keeps a URL with no query, and a path with brackets", () => {
    const text =
      "Docs: https://help.example.com/reset and https://en.wikipedia.org/wiki/Foo_(bar) now"
    expect(body(text)).toBe(text)
  })

  it("keeps the scheme, host, and path of a link that is not https", () => {
    expect(
      body("See [the page](/internal) and [the site](http://x.example.com/a)."),
    ).toBe(
      "See \\[the page\\](/internal) and \\[the site\\](http://x.example.com/a).",
    )
  })

  it("keeps a // that is not a URL", () => {
    expect(body("//#region setup // note")).toBe("//#region setup // note")
  })

  it("keeps a script or a data link as text that is not live", () => {
    // oxlint-disable-next-line no-script-url -- the case is a hostile link
    expect(line("See [click](javascript:alert(1)).")).toBe(
      "See \\[click\\](javascript:alert(1)).",
    )
    expect(line("See [img](data:text/html;base64,PHA+).")).toBe(
      "See \\[img\\](data:text/html;base64,PHA+).",
    )
  })

  it("keeps prose with a colon after a scheme name", () => {
    expect(body("File: report.pdf, Data: none")).toBe(
      "File: report.pdf, Data: none",
    )
  })

  it.each([
    "https://acme.example.com/attachments/token/SECRET/?name=a.png",
    "https://x.example.com/download/Token/SECRET/f.pdf",
  ])("removes a link with a token in its path: %s", (url) => {
    expect(body(`Shot: ${url} now`)).toBe("Shot: \\[link removed\\] now")
  })
})

describe("credentials", () => {
  it.each([
    [
      "postgres://admin:hunter2@10.0.0.5:5432/app",
      "postgres://[credentials removed]@10.0.0.5:5432/app",
    ],
    [
      "redis://:hunter2@localhost:6379",
      "redis://[credentials removed]@localhost:6379",
    ],
    [
      "mongodb+srv://u:hunter2!@cluster0.example.net/db",
      "mongodb+srv://[credentials removed]@cluster0.example.net/db",
    ],
    [
      "https://u:hunter2@x.example.com/a",
      "https://[credentials removed]@x.example.com/a",
    ],
    [
      "https://u:hun@ter2@x.example.com/a",
      "https://[credentials removed]@x.example.com/a",
    ],
    [
      "//u:hunter2@cdn.example.com/a",
      "//[credentials removed]@cdn.example.com/a",
    ],
    [
      "1postgres://admin:hunter2@db.example.com/app",
      "1postgres://[credentials removed]@db.example.com/app",
    ],
    [
      "_postgres://admin:hunter2@db.example.com/app",
      "_postgres://[credentials removed]@db.example.com/app",
    ],
  ])("removes the userinfo of %s", (url, kept) => {
    const escapedKept = kept.replace(/[[\]]/g, "\\$&")
    expect(body(`Use ${url} now`)).toBe(`Use ${escapedKept} now`)
    expect(line(url)).toBe(escapedKept)
  })

  it.each([
    ["token=SECRET", "token=\\[removed\\]"],
    ["my api_key=SECRET here", "my api_key=\\[removed\\] here"],
    ["x&secret=SECRET&y=1", "x&secret=\\[removed\\]&y=1"],
    ["Sig=SECRET", "Sig=\\[removed\\]"],
    ["client.password=SECRET", "client.password=\\[removed\\]"],
  ])("removes a credential parameter outside a URL: %s", (text, kept) => {
    expect(body(text)).toBe(kept)
  })

  it("keeps normal text with an equals sign", () => {
    const text = "a=b and k=v&x=1, barcode=123 and zipcode=4000"
    expect(body(text)).toBe(text)
  })
})

describe("one cut", () => {
  const address = "jo.smith@example.com"
  const leaks = /jo\.smith|@example|smith@|example\.c/

  it("cuts a long body at a word and says so", () => {
    const { text, cut } = customerText("word ".repeat(40_000), {
      maxChars: 16_384,
    })
    expect(cut).toBe(true)
    expect(text.length).toBeLessThanOrEqual(16_384)
    expect(text.endsWith("word")).toBe(true)
  })

  it("does not cut or mark a short text", () => {
    expect(customerText("Short", { maxChars: 100 })).toEqual({
      text: "Short",
      cut: false,
    })
    expect(customerLine("Short", { maxChars: 100 })).toBe("Short")
  })

  it("marks a cut field", () => {
    expect(customerLine("one two three", { maxChars: 9 })).toBe("one two…")
  })

  it("collapses spaces before it cuts a field", () => {
    expect(
      customerLine(`Slow${" ".repeat(100_000)}title`, { maxChars: 1_000 }),
    ).toBe("Slow title")
  })

  it("drops the start of an address that the cut splits", () => {
    for (const [text, maxChars] of [
      [`${"x ".repeat(8190)}jo.park@example.com tail`, 16_384],
      [`${"x".repeat(985)} ${address}`, 1_000],
      [`${"x".repeat(19_990)} ${address} and more`, 20_000],
    ] as const) {
      expect(customerText(text, { maxChars }).text).not.toMatch(
        /jo\.park|jo\.smith|example\.c/,
      )
      expect(customerLine(text, { maxChars })).not.toMatch(
        /jo\.park|jo\.smith|example\.c/,
      )
    }
  })

  // A run with no space for 2,100 characters keeps the cut near the limit,
  // so sweep the address over it.
  it.each([
    ["a body", 16_384],
    ["a field", 2_048],
  ])("keeps no part of an address in %s with no space", (_name, maxChars) => {
    for (const filler of ["(", "<a>", "你"]) {
      for (let shift = 0; shift <= address.length + 2; shift += 1) {
        const start = maxChars - shift
        const text = `${filler.repeat(Math.ceil(start / filler.length)).slice(0, start)}${address}${"z".repeat(maxChars)}`
        expect(customerText(text, { maxChars }).text).not.toMatch(leaks)
        expect(customerLine(text, { maxChars })).not.toMatch(leaks)
      }
    }
  })

  it.each([
    ["an accented address in CJK text", "你好世界josé@exámple.com"],
    ["a userinfo", "postgres://admin:hunter2@db.example.com/app"],
  ])("keeps no part of %s that a cut with no space splits", (_name, token) => {
    for (let shift = 1; shift < token.length; shift += 1) {
      const maxChars = 4_000
      const text = `${"你".repeat(maxChars - shift)}${token}${"你".repeat(10)}`
      const { text: out } = customerText(text, { maxChars })
      expect(out).not.toMatch(/jos|@ex|hunter|admin/)
      expect(out).toContain("你你你")
    }
  })

  it("keeps no fragment after long credential links", () => {
    const link = `https://f.example.com/${"p".repeat(300)}?token=SECRET`
    for (let shift = 0; shift <= address.length + 2; shift += 1) {
      const links = `<${link}>`.repeat(
        Math.floor((16 * 1024) / (link.length + 2)),
      )
      const pad = "<".repeat(Math.max(0, 16 * 1024 - shift - links.length))
      const { text } = customerText(
        `${links}${pad}${address}${"z".repeat(600)}`,
        { maxChars: 16 * 1024 },
      )
      expect(text).not.toMatch(/jo\.smith|@example|smith@|SECRET/)
    }
  })

  it("keeps no part of an address after links that the redaction makes shorter", () => {
    let text = ""
    while (text.length < 3_800)
      text += `https://f.example.com/a?token=${"x".repeat(70)} `
    const rest = 3_991 - text.length
    text += `https://f.example.com/a?token=${"x".repeat(rest - 31)} `
    const titled = `${text}${address} tail`
    // The links keep the host f.example.com, so look for the address only.
    const part = /jo\.smith|smith@|@example/
    expect(customerLine(titled, { maxChars: 4_000 })).not.toMatch(part)
    expect(customerText(titled, { maxChars: 4_000 }).text).not.toMatch(part)
  })

  it("keeps no part of an address when a cut has no space to walk back to", () => {
    const name = `http://${"b".repeat(1_946)}<http://${"a".repeat(2_025)}<${address} tail`
    expect(customerLine(name, { maxChars: 4_000 })).not.toMatch(leaks)
  })

  it.each([
    ["call +1 555 123 4567", /555|123|4567/],
    ["call +61 412 345 678", /412|345|678/],
    ["call 0412 345 678", /0412|345|678/],
  ])("keeps no part of a phone number after %s", (text, leak) => {
    for (const maxChars of [16_384, 2_048]) {
      for (let shift = 0; shift <= text.length + 1; shift += 1) {
        const start = maxChars - shift
        const lead = "x ".repeat(Math.ceil(start / 2)).slice(0, start - 1)
        const input = `${lead} ${text} ${"y ".repeat(40)}`
        expect(customerText(input, { maxChars }).text).not.toMatch(leak)
        expect(customerLine(input, { maxChars })).not.toMatch(leak)
      }
    }
  })

  it("leaves no digit of a phone number after long links", () => {
    const link = (n: number) => `http://${"a".repeat(n - 7)}`
    const title = `${link(2040)} ${link(1943)} call 0412 345 678 now`
    const out = customerLine(title, { maxChars: 4_000 })
    expect(out).not.toMatch(/0412|345/)
    expect(out).toContain("call")
    expect(out).not.toContain("call 0")
  })

  it.each([
    ["a body", 16_384, "你好世界".repeat(4200)],
    ["a field", 2_048, "你好世界".repeat(600)],
    ["a long Japanese body", 20_000, "あ".repeat(120_000)],
  ])("keeps the start of %s with no space", (_name, maxChars, text) => {
    const out = customerText(text, { maxChars })
    expect(out.cut).toBe(true)
    expect(out.text.length).toBeGreaterThan(maxChars - 400)
    expect(customerLine(text, { maxChars }).length).toBeGreaterThan(
      maxChars - 400,
    )
  })

  it("does not split a surrogate pair", () => {
    for (const maxChars of [1_001, 1_002]) {
      const { text } = customerText("😀".repeat(2_000), { maxChars })
      expect(text).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(text.length).toBeGreaterThan(500)
    }
  })
})

describe("article links", () => {
  const policies: ArticlePolicy[] = ["credential-links", "queries", "full"]

  it.each(policies)("keeps an https link with no query (%s)", (policy) => {
    expect(
      safeHref("https://acme.zendesk.com/hc/en-us/articles/2", policy),
    ).toBe("https://acme.zendesk.com/hc/en-us/articles/2")
  })

  it.each(policies)(
    "drops a link that is not https, or that is relative (%s)",
    (policy) => {
      for (const href of [
        "http://help.example.com/plain",
        "mailto:help@example.com",
        "/internal/page",
        "//cdn.example.com/x",
        // oxlint-disable-next-line no-script-url -- the case is a hostile link
        "javascript:alert(1)",
        "data:text/html;base64,PHA+",
      ])
        expect(safeHref(href, policy)).toBeNull()
    },
  )

  it.each(policies)(
    "drops a link with a userinfo or a token path (%s)",
    (policy) => {
      for (const href of [
        "https://u:hunter2@x.example.com/a",
        "https://acme.zendesk.com/attachments/token/s1/?name=a.png",
      ])
        expect(safeHref(href, policy)).toBeNull()
    },
  )

  it.each([
    "https://files.example.com/log?X-Amz-Signature=s1",
    "https://x.example.com/f?token=s1",
    "https://x.example.com/v1?api_key=s1",
    "https://x.example.com/cb#access_token=s1",
    "https://x.example.com/f?%74oken=s1",
    "https://x.example.com/f?to​ken=s1",
    "https://x.example.com/a b?token=s1",
    "https://x.example.com/a\tb?token=s1",
  ])("drops a credential link for credential-links: %s", (href) => {
    expect(safeHref(href, "credential-links")).toBeNull()
  })

  it("keeps a link with a normal query for credential-links", () => {
    expect(
      safeHref("https://help.example.com/a?lang=en", "credential-links"),
    ).toBe("https://help.example.com/a?lang=en")
  })

  it.each(["queries", "full"] as const)(
    "removes the query and the fragment for %s",
    (policy) => {
      expect(
        safeHref("https://files.example.com/log?X-Amz-Signature=s1", policy),
      ).toBe("https://files.example.com/log")
      expect(safeHref("https://a.com/one?x=1#top", policy)).toBe(
        "https://a.com/one",
      )
    },
  )

  it.each(policies)(
    "encodes the marks that could end the link (%s)",
    (policy) => {
      expect(
        safeHref(
          "https://a.example/x\n\n![p](https://track.example/p.png",
          policy,
        ),
      ).toBe("https://a.example/x%0A%0A![p]%28https://track.example/p.png")
      expect(
        safeHref(
          "https://a.example/x)![i](https://track.example/p.png",
          policy,
        ),
      ).toBe("https://a.example/x%29![i]%28https://track.example/p.png")
      expect(safeHref("https://a.example/x y<z>\\", policy)).toBe(
        "https://a.example/x%20y%3Cz%3E%5C",
      )
    },
  )
})

describe("article bodies", () => {
  // Markdown as the converter writes it: the `a` translator puts in the link
  // that `safeHref` gave, and the text is escaped.
  const markdown = [
    "## Steps",
    "",
    "Open **Settings** and select [Security](https://help.example.com/articles/security).",
    "",
    "- One",
    "- Two",
    "",
    "\\[Image: Settings screen\\]",
    "",
    "```",
    "npm run reset //#region setup",
    "```",
  ].join("\n")

  it.each(["credential-links", "queries", "full"] as const)(
    "keeps headings, lists, code, and safe links (%s)",
    (policy) => {
      expect(articleText(markdown, policy)).toBe(markdown)
    },
  )

  it.each(["credential-links", "queries", "full"] as const)(
    "keeps two adjacent links apart (%s)",
    (policy) => {
      const links = "[one](https://a.com/one)[two](https://b.com/two)"
      expect(articleText(links, policy)).toBe(links)
    },
  )

  it.each(["credential-links", "queries", "full"] as const)(
    "strips at entry, without a live mark from NFKC (%s)",
    (policy) => {
      expect(
        articleText(
          "Mail​ ok ［x］（javascript:alert(1)） ＜b＞ `a｀[x](https://evil.example.com)`",
          policy,
        ),
      ).toBe(
        "Mail ok ［x］(javascript:alert(1)) ＜b＞ `a｀[x](https://evil.example.com)`",
      )
    },
  )

  it.each(["credential-links", "queries", "full"] as const)(
    "removes credentials in text (%s)",
    (policy) => {
      for (const [text, secret] of [
        ["https://f.example.com/a?to​ken=SECRET", "SECRET"],
        ["postgres://admin:hunter2@10.0.0.5:5432/app", "hunter2"],
        ["redis://:hunter2@localhost:6379", "hunter2"],
        ["mongodb+srv://u:p4ss!@cluster0.example.net/db", "p4ss"],
        ["...https://u:hunter2@x.example.com/a", "hunter2"],
        ["files.example.com/log?token=SECRET", "SECRET"],
        ["wwww.example.com/?token=SECRET", "SECRET"],
        ["Use token=SECRET here", "SECRET"],
        [
          "[https://help.example.com/a?token=SECRET](https://help.example.com/a)",
          "SECRET",
        ],
        ["https://acme.example.com/attachments/token/SECRET/a.png", "SECRET"],
      ] as const)
        expect(articleText(`See ${text} now`, policy)).not.toContain(secret)
    },
  )

  describe("credential-links", () => {
    const text = (markdown: string) => articleText(markdown, "credential-links")

    it("removes a URL with a credential or another scheme, and keeps the rest", () => {
      expect(
        text(
          "relative [secure](https://help.example.com/ok) http://help.example.com/bare and https://f.example.com/a?token=SECRET.",
        ),
      ).toBe(
        "relative [secure](https://help.example.com/ok) \\[link removed\\] and \\[link removed\\].",
      )
    })

    it("keeps a URL with a normal query, an address, and a phone number", () => {
      const kept =
        "See https://help.example.com/a?lang=en, mail jo@example.com or call 0412 345 678."
      expect(text(kept)).toBe(kept)
    })

    it("removes a URL whose query has an encoded credential name", () => {
      expect(text("See https://f.example.com/a?%74oken=SECRET")).toBe(
        "See \\[link removed\\]",
      )
    })
  })

  describe("queries", () => {
    it("removes each query, and keeps addresses and phone numbers", () => {
      expect(
        articleText(
          "Open https://f.example.com/l?code=SECRET or [https://help.example.com/a?k=SECRET](https://help.example.com/a). Mail jo@example.com or call 0412 345 678.",
          "queries",
        ),
      ).toBe(
        "Open https://f.example.com/l or [https://help.example.com/a](https://help.example.com/a). Mail jo@example.com or call 0412 345 678.",
      )
    })
  })

  describe("full", () => {
    const text = (markdown: string) => articleText(markdown, "full")

    it("removes queries, addresses, and phone numbers, with escaped markers", () => {
      expect(
        text(
          "Open https://f.example.com/l?code=SECRET. Call +61 412 345 678 or jo.smith@example.com",
        ),
      ).toBe(
        "Open https://f.example.com/l. Call \\[phone removed\\] or \\[email removed\\]",
      )
    })

    it("does not let a marker become a link", () => {
      expect(text("Mail jo@example.com(https://evil.example.com)")).toBe(
        "Mail \\[email removed\\](https://evil.example.com)",
      )
    })

    it("removes an address that the Markdown escape split", () => {
      expect(text("Mail jo\\_smith@example.com now")).toBe(
        "Mail \\[email removed\\] now",
      )
    })

    it("keeps the userinfo marker apart from the address rule", () => {
      expect(text("Use https://u:p@x.example.com/a now")).toBe(
        "Use https://\\[credentials removed\\]@x.example.com/a now",
      )
    })

    it("keeps a version in a code span and a code block", () => {
      const code = "Run `10.15.7.123456` and\n\n```\nv 2.0.20261014\n```"
      expect(text(code)).toBe(code)
    })
  })
})

describe("time", () => {
  // The worst shapes from the security reviews, at 5,000,000 characters,
  // through the whole redaction (no cut) and the article link rule. A
  // super-linear pass takes hours here; a linear one takes seconds. One
  // generous bound keeps a slow CI runner green.
  it("redacts long hostile text in linear time", () => {
    const n = 5_000_000
    const shapes = [
      "a".repeat(n),
      `${"a".repeat(n - 1)}@`,
      `?${"k".repeat(n - 1)}`,
      "https://".repeat(n / 8),
      "x://".repeat(n / 4),
      "a=b&".repeat(n / 4),
      "a.".repeat(n / 2),
      "a.bc/".repeat(n / 5),
      "_www.".repeat(n / 5),
      "/".repeat(n),
      " /a".repeat(n / 3),
      "[a](https://x.co/a?y=1)".repeat(n / 23),
      "](".repeat(n / 2),
      "\ufe0f".repeat(n),
      "\u200b".repeat(n),
      "a\ufe0f.".repeat(n / 3),
      "jo@x.co ".repeat(n / 8),
      "@a.bc".repeat(n / 5),
      "你@你.".repeat(n / 4),
      "你1 ".repeat(n / 3),
      "😀".repeat(n / 2),
      `${" ".repeat(n)}x`,
      `${"\t".repeat(n)}x`,
      `${"1".repeat(n)}a`,
      `${"1 ".repeat(n / 2)}:`,
      "```a ".repeat(n / 5),
    ]
    const start = performance.now()
    for (const text of shapes) {
      customerText(text, { maxChars: text.length })
      articleText(text, "credential-links")
    }
    expect(performance.now() - start).toBeLessThan(60_000)
  }, 120_000)
})
