import { describe, expect, it } from "vitest"

import {
  chunkKnowledgeBody,
  documentChunks,
  markdownLines,
} from "./knowledge-chunks.js"

const texts = (body: string) =>
  chunkKnowledgeBody(body).map((chunk) => chunk.text)

describe("markdownLines", () => {
  it("closes a fence only with the same character, at least the opening length, and no info string", () => {
    const headings = markdownLines(
      [
        "````md",
        "```",
        "# inside four",
        "```js",
        "````",
        "# Outside",
        "~~~",
        "```",
        "# inside tilde",
        "~~~~ ",
        "## After",
      ].join("\n"),
    ).flatMap((line) => (line.heading ? [line.heading] : []))
    expect(headings).toEqual(["Outside", "After"])
  })
})

describe("chunkKnowledgeBody", () => {
  it("starts a chunk at each heading outside a code fence, with its heading path and lines", () => {
    expect(
      chunkKnowledgeBody(
        "Intro.\n\n# One\nFirst.\n\n```md\n# not a heading\n```\n## Two\nSecond.\n# Three\nThird.\n",
      ),
    ).toEqual([
      { headingPath: [], text: "Intro.", startLine: 1, endLine: 1 },
      {
        headingPath: ["One"],
        text: "# One\nFirst.\n\n```md\n# not a heading\n```",
        startLine: 3,
        endLine: 8,
      },
      {
        headingPath: ["One", "Two"],
        text: "## Two\nSecond.",
        startLine: 9,
        endLine: 10,
      },
      {
        headingPath: ["Three"],
        text: "# Three\nThird.",
        startLine: 11,
        endLine: 12,
      },
    ])
  })

  it("joins a heading-only section to the next section, with both headings in the path", () => {
    expect(
      chunkKnowledgeBody(
        "# Plan\n\n## Phase 4: tests\n\nRun the evals.\n## Phase 5\n### Step 1\nShip.\n",
      ),
    ).toEqual([
      {
        headingPath: ["Plan", "Phase 4: tests"],
        text: "# Plan\n\n## Phase 4: tests\n\nRun the evals.",
        startLine: 1,
        endLine: 5,
      },
      {
        headingPath: ["Plan", "Phase 5", "Step 1"],
        text: "## Phase 5\n### Step 1\nShip.",
        startLine: 6,
        endLine: 8,
      },
    ])
  })

  it("drops a heading-only section at the end, unless the body has no other text", () => {
    expect(texts("# A\nAlpha.\n## B\n\n## C\n")).toEqual(["# A\nAlpha."])
    expect(texts("# Only\n\n## Sub\n")).toEqual(["# Only\n\n## Sub"])
  })

  it("keeps the headings of a section over the cap with its first paragraph", () => {
    const long = "x".repeat(3000)
    const chunks = chunkKnowledgeBody(`# Parent\n\n## Child\n\n${long}\n`)
    expect(
      chunks.map(({ headingPath, text, startLine, endLine }) => ({
        headingPath,
        start: text.slice(0, 22),
        length: text.length,
        startLine,
        endLine,
      })),
    ).toEqual([
      {
        headingPath: ["Parent", "Child"],
        start: "# Parent\n\n## Child\n\nxx",
        length: 2048,
        startLine: 1,
        endLine: 5,
      },
      {
        headingPath: ["Parent", "Child"],
        start: "x".repeat(22),
        length: "# Parent\n\n## Child\n\n".length + 3000 - 2048,
        startLine: 5,
        endLine: 5,
      },
    ])
  })

  it("starts the first chunk at the first line with text, as the older rule did", () => {
    for (const body of [
      "\n# Title\n\n## Sub\nText.\n",
      "\nIntro.\n# Title\nText.\n",
      "\n\n# Title\n## Sub\n",
    ])
      expect(chunkKnowledgeBody(body)[0]?.startLine).toBe(
        body.split("\n").findIndex((line) => line.trim()) + 1,
      )
  })

  it("drops empty sections and returns nothing for a blank body", () => {
    expect(texts("\n\n")).toEqual([])
    expect(texts("# Only\n")).toEqual(["# Only"])
  })

  it("packs paragraphs of a section over the cap, then splits on length", () => {
    const chunks = chunkKnowledgeBody(
      `# Long\n${"a".repeat(1500)}\n\n${"b".repeat(1500)}\n\n${"c".repeat(5000)}`,
    )
    expect(
      chunks.map(({ text, startLine, endLine }) => [
        text.length,
        startLine,
        endLine,
      ]),
    ).toEqual([
      ["# Long\n".length + 1500, 1, 2],
      [1500, 4, 4],
      [2048, 6, 6],
      [2048, 6, 6],
      [5000 - 4096, 6, 6],
    ])
  })

  it("does not split an emoji at a length boundary", () => {
    const body = `${"x".repeat(2047)}😀${"y".repeat(2100)}`
    const chunks = texts(body)
    expect(chunks.join("")).toBe(body)
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true)
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/.test(chunk))).toBe(true)
  })

  it("keeps an edit inside one section from changing the other chunks", () => {
    const before = texts("# A\nAlpha.\n# B\nBeta.\n# C\nGamma.\n")
    const after = texts("# A\nAlpha.\n# B\nBeta, now longer.\n# C\nGamma.\n")
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[2]).toBe(before[2])
  })
})

describe("documentChunks", () => {
  it("puts the title and heading path first, and offsets lines past front matter", () => {
    expect(
      documentChunks({
        body: "# A\nOne.\n## B\nTwo.\n",
        title: "Guide",
        bodyStartLine: 4,
      }),
    ).toEqual([
      { ordinal: 0, startLine: 4, endLine: 5, text: "Guide > A\n\n# A\nOne." },
      {
        ordinal: 1,
        startLine: 6,
        endLine: 7,
        text: "Guide > A > B\n\n## B\nTwo.",
      },
    ])
    expect(
      documentChunks({ body: "Same.\n\n# H\nSame.\n", title: null }),
    ).toEqual([
      { ordinal: 0, startLine: 1, endLine: 1, text: "Same." },
      { ordinal: 1, startLine: 3, endLine: 4, text: "H\n\n# H\nSame." },
    ])
    expect(documentChunks({ body: "", title: "Empty" })).toEqual([])
  })
})
