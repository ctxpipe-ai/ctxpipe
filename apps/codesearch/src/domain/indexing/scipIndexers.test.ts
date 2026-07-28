import { describe, expect, it } from "vitest"
import type { ScipIndexerId } from "./detectLanguages.js"
import { SCIP_INDEXER_ARGV } from "./scipIndexers.js"

describe("SCIP_INDEXER_ARGV", () => {
  it.each<[ScipIndexerId, readonly string[]]>([
    ["go", ["scip-go"]],
    ["typescript", ["scip-typescript", "index"]],
    ["python", ["scip-python", "index", "."]],
    ["java", ["scip-java", "index"]],
    ["rust", ["rust-analyzer", "scip", "."]],
    ["clang", ["scip-clang", "--compdb-path=compile_commands.json"]],
    ["ruby", ["scip-ruby"]],
    ["dotnet", ["scip-dotnet", "index"]],
    ["dart", ["scip-dart"]],
    ["php", ["scip-php"]],
    ["debian", ["debian-lsp", "scip", "."]],
  ])("maps %s to its official CLI", (indexerId, expectedArgv) => {
    expect(SCIP_INDEXER_ARGV[indexerId]).toEqual(expectedArgv)
  })

  it("contains exactly every detected indexer family", () => {
    expect(Object.keys(SCIP_INDEXER_ARGV)).toEqual([
      "go",
      "typescript",
      "python",
      "java",
      "rust",
      "clang",
      "ruby",
      "dotnet",
      "dart",
      "php",
      "debian",
    ])
  })
})
