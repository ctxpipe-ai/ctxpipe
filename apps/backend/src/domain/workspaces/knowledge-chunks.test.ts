import { describe, expect, it } from "vitest"

import {
  chunkKnowledgeBody,
  knowledgeChunkRows,
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
        "Intro.\n\n# One\nFirst.\n\n```md\n# not a heading\n```\n## Two\nSecond.\n# Three\n",
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
      { headingPath: ["Three"], text: "# Three", startLine: 11, endLine: 11 },
    ])
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

describe("knowledgeChunkRows", () => {
  const unit = (servingId: string, body: string, title: string | null) => ({
    servingId,
    body,
    title,
  })

  it("puts the title and heading path first, keys repeats by occurrence, and offsets lines past front matter", () => {
    const rows = knowledgeChunkRows(
      [
        {
          ...unit("kn_a", "# A\nOne.\n## B\nTwo.\n", "Guide"),
          bodyStartLine: 4,
        },
        unit("kn_b", "Same.\n\n# H\nSame.\n", null),
        unit("kn_c", "", "Empty"),
      ],
      "model-1",
    )
    expect(
      rows.map(({ unitId, occurrence, ordinal, startLine, endLine, text }) => ({
        unitId,
        occurrence,
        ordinal,
        startLine,
        endLine,
        text,
      })),
    ).toEqual([
      {
        unitId: "kn_a",
        occurrence: 0,
        ordinal: 0,
        startLine: 4,
        endLine: 5,
        text: "Guide > A\n\n# A\nOne.",
      },
      {
        unitId: "kn_a",
        occurrence: 0,
        ordinal: 1,
        startLine: 6,
        endLine: 7,
        text: "Guide > A > B\n\n## B\nTwo.",
      },
      {
        unitId: "kn_b",
        occurrence: 0,
        ordinal: 0,
        startLine: 1,
        endLine: 1,
        text: "Same.",
      },
      {
        unitId: "kn_b",
        occurrence: 0,
        ordinal: 1,
        startLine: 3,
        endLine: 4,
        text: "H\n\n# H\nSame.",
      },
    ])
    expect(rows[0]?.chunkHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("gives a repeated chunk a second occurrence and changes every hash with the model", () => {
    const body = "Same.\n\nOther.\n\n```\n```\n"
    const repeated = knowledgeChunkRows(
      [unit("kn_a", "# X\nSame.\n# X\nSame.\n", null)],
      "model-1",
    )
    expect(repeated.map(({ occurrence }) => occurrence)).toEqual([0, 1])
    expect(repeated[0]?.chunkHash).toBe(repeated[1]?.chunkHash)
    const [one] = knowledgeChunkRows([unit("kn_a", body, null)], "model-1")
    const [two] = knowledgeChunkRows([unit("kn_a", body, null)], "model-2")
    expect(one?.chunkHash).not.toBe(two?.chunkHash)
  })
})
