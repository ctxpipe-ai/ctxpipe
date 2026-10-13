import { describe, expect, it } from "vitest"
import { chunkKnowledgeBody, knowledgeChunkRows } from "./knowledge-chunks.js"

describe("chunkKnowledgeBody", () => {
  it("starts a chunk at each heading outside a code fence", () => {
    expect(
      chunkKnowledgeBody(
        "Intro.\n\n# One\nFirst.\n\n```md\n# not a heading\n```\n## Two\nSecond.\n",
      ),
    ).toEqual([
      "Intro.",
      "# One\nFirst.\n\n```md\n# not a heading\n```",
      "## Two\nSecond.",
    ])
  })

  it("drops empty sections and returns nothing for a blank body", () => {
    expect(chunkKnowledgeBody("\n\n")).toEqual([])
    expect(chunkKnowledgeBody("# Only\n")).toEqual(["# Only"])
  })

  it("splits a section over the cap on blank lines, then on length", () => {
    const paragraph = (char: string) => `${char.repeat(1500)}`
    const chunks = chunkKnowledgeBody(
      `# Long\n${paragraph("a")}\n\n${paragraph("b")}\n\n${"c".repeat(5000)}`,
    )
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      "# Long\n".length + 1500,
      1500,
      2048,
      2048,
      5000 - 4096,
    ])
    expect(chunks.every((chunk) => chunk.length <= 2048)).toBe(true)
  })

  it("keeps an edit inside one section from changing the other chunks", () => {
    const before = chunkKnowledgeBody("# A\nAlpha.\n# B\nBeta.\n# C\nGamma.\n")
    const after = chunkKnowledgeBody(
      "# A\nAlpha.\n# B\nBeta, now longer.\n# C\nGamma.\n",
    )
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[2]).toBe(before[2])
  })
})

describe("knowledgeChunkRows", () => {
  it("numbers the chunks of each unit and hashes their text", () => {
    const rows = knowledgeChunkRows([
      { servingId: "kn_a", body: "# A\nOne.\n# B\nTwo.\n" },
      { servingId: "kn_b", body: "# A\nOne.\n" },
      { servingId: "kn_c", body: "" },
    ])
    expect(rows.map(({ unitId, ordinal }) => [unitId, ordinal])).toEqual([
      ["kn_a", 0],
      ["kn_a", 1],
      ["kn_b", 0],
    ])
    expect(rows[0]?.chunkHash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[2]?.chunkHash).toBe(rows[0]?.chunkHash)
    expect(rows[1]?.chunkHash).not.toBe(rows[0]?.chunkHash)
  })
})
