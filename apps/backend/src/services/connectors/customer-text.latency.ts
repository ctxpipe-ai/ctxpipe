import { describe, expect, it } from "vitest"

import { articleText, customerText } from "./customer-text.js"

// Wall-clock bounds of the redaction and the parser check. They are not in the
// PR suite, because a shared runner can make one shape many times slower (a
// shape of about 3 seconds on a laptop took 53 seconds on CI). Run them after
// a change to the redaction rules, the parse-cost estimate (`parseCost`), or a
// Markdown parser version: pnpm --filter @ctxpipe/backend test:latency
describe("time", () => {
  // The worst shapes from the security reviews, at 5,000,000 characters,
  // through the whole redaction (no cut) and the article link rule. A
  // super-linear pass takes hours here; a linear one takes seconds. One
  // generous bound allows a slow machine.
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
      "`\u200b".repeat(n / 2),
      "\n".repeat(n),
      `${"-".repeat(n)}x`,
      "a.bc:1".repeat(n / 6),
      "//a".repeat(n / 3),
      `https://x.co/${"%25".repeat(n / 3)}`,
      "a@b\u3002".repeat(n / 4),
      `\`${"\u200b".repeat(n)}`,
      "a <b> ".repeat(n / 6),
      "a:@ ".repeat(n / 4),
      "-www.a:@".repeat(n / 8),
      "//a@".repeat(n / 4),
      "a:b@c.de/ ".repeat(n / 10),
    ]
    const start = performance.now()
    for (const text of shapes) {
      customerText(text, { maxChars: text.length })
      articleText(text, "credential-links")
    }
    expect(performance.now() - start).toBeLessThan(60_000)
  }, 120_000)

  // The slowest shapes that the pre-scan lets through to the parse, each just
  // below the bound of one term of the estimate: a `[` that does not pair, an
  // email address run, unclosed HTML, character references, lists nested to
  // the cap again and again, lazy lines in a list at the cap, a long list
  // item with lazy lines, a long GFM table, and many small blocks.
  // The result keeps its link, so the parser check read it.
  it("checks the slowest shapes that the pre-scan passes", () => {
    const link = "[x](https://ok.example/)"
    const shapes = [
      `[${"*a".repeat(12_000)} ${link}`,
      `${link} ${"a-".repeat(35_000)}`,
      `${link} ${"<?".repeat(7_000)}`,
      `${link} ${"x &amp; y ".repeat(10_000)}`,
      Array.from({ length: 1_150 }, (_, i) => `${"1. ".repeat(i % 42)}a\n`)
        .join("")
        .concat(`\n${link}`),
      Array.from({ length: 63 }, (_, i) => `${"  ".repeat(i)}- a\n`)
        .join("")
        .concat("a\n".repeat(8_000), `\n${link}`),
      `${link}\n\n- a\n${"b\n".repeat(8_000)}`,
      `${link}\n\na|b\n-|-\n${"a|b\n".repeat(4_500)}`,
      `${"x\n\n".repeat(30_000)}${link}`,
    ]
    for (const text of shapes) {
      const start = performance.now()
      const out = articleText(text, "credential-links")
      expect(performance.now() - start).toBeLessThan(10_000)
      expect(out).toContain(link)
    }
  }, 120_000)
})
