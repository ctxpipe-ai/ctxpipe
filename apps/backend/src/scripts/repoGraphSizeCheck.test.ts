import { describe, expect, it } from "vitest"
import {
  compareRepoGraph,
  countScipDocuments,
  estimateRepoGraph,
  measuredRepoGraph,
} from "./repoGraphSizeCheck.js"

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
      units: 2,
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

describe("measuredRepoGraph and compareRepoGraph", () => {
  it("counts package kinds together and flags a bound the units miss", () => {
    const actual = measuredRepoGraph({
      Service: 2,
      Library: 1,
      InstructionUnit: 1,
      "(none)": 3,
    })
    expect(actual).toEqual({
      "Service+App+Library": 3,
      InstructionUnit: 1,
      Decision: 0,
      units: 7,
    })
    expect(
      compareRepoGraph(
        { "Service+App+Library": 3, Decision: 1, scipDocuments: 10 },
        actual,
      ),
    ).toEqual([
      { name: "Service+App+Library", expected: 3, actual: 3, ok: true },
      { name: "Decision", expected: 1, actual: 0, ok: false },
      { name: "scipDocuments", expected: 10, actual: null, ok: null },
    ])
  })
})
