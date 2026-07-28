import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "protobufjs"
import { describe, expect, it } from "vitest"
import { executeScipGraphQuery } from "./executeGraphPrimitive.js"

const indexMessage = parse(`
  syntax = "proto3";
  package scip;

  message Index {
    repeated Document documents = 2;
    repeated SymbolInformation external_symbols = 3;
  }
  message Document {
    string relative_path = 1;
    repeated Occurrence occurrences = 2;
    repeated SymbolInformation symbols = 3;
  }
  message SymbolInformation {
    string symbol = 1;
    repeated string documentation = 3;
    repeated Relationship relationships = 4;
    int32 kind = 5;
    string display_name = 6;
    string enclosing_symbol = 8;
  }
  message Relationship {
    string symbol = 1;
    bool is_reference = 2;
    bool is_implementation = 3;
    bool is_type_definition = 4;
    bool is_definition = 5;
  }
  message SingleLineRange {
    int32 line = 1;
    int32 start_character = 2;
    int32 end_character = 3;
  }
  message MultiLineRange {
    int32 start_line = 1;
    int32 start_character = 2;
    int32 end_line = 3;
    int32 end_character = 4;
  }
  message Occurrence {
    repeated int32 range = 1 [packed = true];
    string symbol = 2;
    int32 symbol_roles = 3;
    int32 syntax_kind = 5;
    repeated int32 enclosing_range = 7 [packed = true];
    SingleLineRange single_line_range = 8;
    MultiLineRange multi_line_range = 9;
    SingleLineRange single_line_enclosing_range = 10;
    MultiLineRange multi_line_enclosing_range = 11;
  }
`).root.lookupType("scip.Index")

const symbols = {
  base: "scip-typescript npm example 1.0.0 src/base.ts/Base#",
  child: "scip-typescript npm example 1.0.0 src/main.ts/Child#",
  helper: "scip-typescript npm example 1.0.0 src/helper.ts/helper().",
  main: "scip-typescript npm example 1.0.0 src/main.ts/main().",
}

function fixtureIndex(mainDisplayName = "main"): Uint8Array {
  return indexMessage
    .encode(
      indexMessage.create({
        documents: [
          {
            relativePath: "src/main.ts",
            symbols: [
              {
                symbol: symbols.main,
                displayName: mainDisplayName,
                kind: 17,
                documentation: ["Program entry point."],
              },
              {
                symbol: symbols.child,
                displayName: "Child",
                kind: 7,
                relationships: [
                  { symbol: symbols.base, isImplementation: true },
                ],
              },
            ],
            occurrences: [
              {
                range: [0, 7, 11],
                symbol: symbols.base,
                symbolRoles: 2,
                syntaxKind: 19,
              },
              {
                symbol: symbols.main,
                symbolRoles: 1,
                syntaxKind: 16,
                singleLineRange: {
                  line: 2,
                  startCharacter: 9,
                  endCharacter: 13,
                },
                multiLineEnclosingRange: {
                  startLine: 2,
                  startCharacter: 0,
                  endLine: 5,
                  endCharacter: 1,
                },
              },
              {
                range: [3, 2, 8],
                enclosingRange: [3, 2, 10],
                symbol: symbols.helper,
                syntaxKind: 15,
              },
              {
                range: [7, 6, 11],
                enclosingRange: [7, 0, 9, 1],
                symbol: symbols.child,
                symbolRoles: 1,
                syntaxKind: 19,
              },
            ],
          },
          {
            relativePath: "src/helper.ts",
            symbols: [
              {
                symbol: symbols.helper,
                displayName: "helper",
                kind: 17,
              },
              {
                symbol: symbols.base,
                displayName: "Base",
                kind: 7,
              },
            ],
            occurrences: [
              {
                range: [0, 9, 15],
                enclosingRange: [0, 0, 2, 1],
                symbol: symbols.helper,
                symbolRoles: 1,
                syntaxKind: 16,
              },
            ],
          },
        ],
      }),
    )
    .finish()
}

async function queryFixture(
  primitive:
    | "find_symbol"
    | "get_callers"
    | "get_callees"
    | "get_imports"
    | "get_type_hierarchy"
    | "get_containing_scope"
    | "trace_path",
  input: {
    symbol?: string
    filePath?: string
    module?: string
    endSymbol?: string
  },
) {
  const dir = mkdtempSync(join(tmpdir(), "scip-graph-"))
  const scipIndexPath = join(dir, "index.scip")
  writeFileSync(scipIndexPath, fixtureIndex())
  const result = await executeScipGraphQuery({
    primitive,
    scipIndexPath,
    repoPath: dir,
    ...input,
  })
  rmSync(dir, { recursive: true, force: true })
  return result
}

describe("executeScipGraphQuery", () => {
  it("returns a friendly soft miss when the SCIP index is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scip-missing-"))
    const missingIndex = join(dir, "definitely-missing.scip")
    try {
      const res = await executeScipGraphQuery({
        primitive: "get_callers",
        scipIndexPath: missingIndex,
        repoPath: join(dir, "repo"),
        symbol: "foo",
      })
      expect(res.ok).toBe(true)
      expect(res.results).toEqual([])
      expect(res.note).toMatch(/not found/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("finds symbol definitions from legacy and typed SCIP ranges", async () => {
    const result = await queryFixture("find_symbol", { symbol: "main" })

    expect(result.ok).toBe(true)
    expect(result.results).toEqual([
      expect.objectContaining({
        symbol: symbols.main,
        displayName: "main",
        kind: "function",
        range: {
          startLine: 2,
          startCharacter: 9,
          endLine: 2,
          endCharacter: 13,
        },
      }),
    ])
  })

  it("finds callers from references enclosed by function definitions", async () => {
    const result = await queryFixture("get_callers", { symbol: "helper" })

    expect(result.ok).toBe(true)
    expect(result.results).toEqual([
      expect.objectContaining({
        caller: "main",
        called: "helper",
        calledSymbol: symbols.helper,
      }),
    ])
  })

  it("finds callees inside a definition enclosing range", async () => {
    const result = await queryFixture("get_callees", { symbol: "main" })

    expect(result.ok).toBe(true)
    expect(result.results).toEqual([
      expect.objectContaining({
        caller: "main",
        called: "helper",
        calledSymbol: symbols.helper,
      }),
    ])
  })

  it("finds SCIP import-role occurrences", async () => {
    const byFile = await queryFixture("get_imports", {
      filePath: "src/main.ts",
    })
    const byModule = await queryFixture("get_imports", {
      module: "src/base.ts",
    })

    expect(byFile.ok).toBe(true)
    expect(byFile.results).toEqual([
      expect.objectContaining({
        symbol: symbols.base,
        displayName: "Base",
        module: "Base",
      }),
    ])
    expect(byModule.results).toHaveLength(1)
  })

  it("returns outgoing and incoming type relationships", async () => {
    const child = await queryFixture("get_type_hierarchy", {
      symbol: "Child",
    })
    const base = await queryFixture("get_type_hierarchy", { symbol: "Base" })

    expect(child.results).toEqual([
      expect.objectContaining({
        relation: "implements",
        source: expect.objectContaining({ displayName: "Child" }),
        target: expect.objectContaining({ displayName: "Base" }),
      }),
    ])
    expect(base.results).toEqual([
      expect.objectContaining({
        relation: "implemented_by",
        source: expect.objectContaining({ displayName: "Child" }),
        target: expect.objectContaining({ displayName: "Base" }),
      }),
    ])
  })

  it("finds the smallest containing definition scope", async () => {
    const result = await queryFixture("get_containing_scope", {
      symbol: "helper",
      filePath: "src/main.ts",
    })

    expect(result.ok).toBe(true)
    expect(result.results).toEqual([
      expect.objectContaining({
        displayName: "helper",
        scopeName: "main",
        scopeSymbol: symbols.main,
        scopeType: "function",
      }),
    ])
  })

  it("traces call paths with depth and optional endpoint", async () => {
    const result = await queryFixture("trace_path", {
      symbol: "main",
      filePath: "src/main.ts",
      endSymbol: "helper",
    })

    expect(result.ok).toBe(true)
    expect(result.note).toBeUndefined()
    expect(result.results).toEqual([
      expect.objectContaining({
        depth: 1,
        caller: "main",
        called: "helper",
      }),
    ])
  })

  it("invalidates the in-process cache when index mtime changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scip-cache-"))
    const scipIndexPath = join(dir, "index.scip")
    try {
      writeFileSync(scipIndexPath, fixtureIndex())
      const first = await executeScipGraphQuery({
        primitive: "find_symbol",
        scipIndexPath,
        repoPath: dir,
        symbol: "main",
      })

      writeFileSync(scipIndexPath, fixtureIndex("renamedMain"))
      const future = new Date(Date.now() + 2_000)
      utimesSync(scipIndexPath, future, future)
      const second = await executeScipGraphQuery({
        primitive: "find_symbol",
        scipIndexPath,
        repoPath: dir,
        symbol: "renamedMain",
      })

      expect(first.results).toHaveLength(1)
      expect(second.results).toEqual([
        expect.objectContaining({ displayName: "renamedMain" }),
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
