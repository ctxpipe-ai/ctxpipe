import { describe, expect, it } from "vitest"
import { buildAstGrepArgv } from "./structuralSearch.js"

describe("buildAstGrepArgv", () => {
  it("builds an ast-grep argv without shell interpretation", () => {
    const argv = buildAstGrepArgv({
      pattern: "$CALL($ARG); rm -rf /",
      lang: "typescript",
      globs: ["src/**/*.ts", "!**/*.test.ts"],
      paths: ["/repo/checkout/src", "/repo/checkout/packages/api"],
    })

    expect(argv).toEqual([
      "ast-grep",
      "run",
      "--pattern",
      "$CALL($ARG); rm -rf /",
      "--json=stream",
      "--lang",
      "typescript",
      "--globs",
      "src/**/*.ts",
      "--globs",
      "!**/*.test.ts",
      "--",
      "/repo/checkout/src",
      "/repo/checkout/packages/api",
    ])
    expect(argv[0]).not.toBe("sg")
  })
})
