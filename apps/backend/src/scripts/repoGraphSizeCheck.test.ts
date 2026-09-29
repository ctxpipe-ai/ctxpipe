import { describe, expect, it } from "vitest"
import { countScipDocuments, estimateRepoGraph } from "./repoGraphSizeCheck.js"

describe("estimateRepoGraph", () => {
  it("scales lower bounds with packages, instruction docs, and TypeScript sources", () => {
    const { facts, expected } = estimateRepoGraph([
      "package.json",
      "README.md",
      "AGENTS.md",
      "packages/core/package.json",
      "packages/core/README.md",
      "packages/core/src/a.ts",
      "packages/core/src/a.d.ts",
      "packages/cli/package.json",
      "packages/cli/src/b.tsx",
      "packages/cli/test/fixtures/package.json",
      "docs/adr/0001-use-ts.md",
    ])

    expect(facts).toMatchObject({
      roots: 2,
      instructionFiles: 3,
      decisionFiles: 1,
      typeScriptSources: 2,
    })
    expect(expected).toEqual({
      "Service+App+Library": 1,
      InstructionUnit: 1,
      Decision: 0,
      objects: 2,
      scipDocuments: 1,
    })
  })
})

describe("countScipDocuments", () => {
  it("counts top-level documents and skips metadata and external symbols", () => {
    const field = (number: number, body: number[]) => [
      (number << 3) | 2,
      body.length,
      ...body,
    ]
    const index = new Uint8Array([
      ...field(1, [0x0a, 0x00]),
      ...field(2, [0x0a, 0x01, 0x61]),
      ...field(2, [0x0a, 0x01, 0x62]),
      ...field(3, [0x0a, 0x01, 0x63]),
    ])

    expect(countScipDocuments(index)).toBe(2)
  })
})
