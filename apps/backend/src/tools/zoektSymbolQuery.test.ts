import { describe, expect, it } from "vitest"
import {
  buildSymbolDefinitionQuery,
  buildSymbolReferencesQuery,
  escapeZoektRegexLiteral,
  escapeZoektSymQuoted,
  languageZoektClause,
} from "./zoektSymbolQuery.js"

describe("escapeZoektSymQuoted", () => {
  it("escapes backslashes and double quotes", () => {
    expect(escapeZoektSymQuoted(`a"b\\c`)).toBe(`a\\"b\\\\c`)
  })
})

describe("escapeZoektRegexLiteral", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeZoektRegexLiteral("foo.bar")).toBe("foo\\.bar")
    expect(escapeZoektRegexLiteral("a/b")).toBe("a\\/b")
  })
})

describe("languageZoektClause", () => {
  it("expands TypeScript family", () => {
    expect(languageZoektClause("TypeScript")).toContain("lang:typescript")
    expect(languageZoektClause("TypeScript")).toContain("lang:javascript")
  })

  it("maps common aliases", () => {
    expect(languageZoektClause("go")).toBe("lang:go")
    expect(languageZoektClause("py")).toBe("lang:python")
  })
})

describe("buildSymbolDefinitionQuery", () => {
  it("builds sym query with lang", () => {
    expect(buildSymbolDefinitionQuery("MyFn", "go")).toBe(
      'sym:"MyFn" lang:go',
    )
  })

  it("rejects empty symbol", () => {
    expect(() => buildSymbolDefinitionQuery("  ", "go")).toThrow(
      "non-empty",
    )
  })
})

describe("buildSymbolReferencesQuery", () => {
  it("builds case-sensitive regex with word boundaries", () => {
    const q = buildSymbolReferencesQuery("MyFn", "go")
    expect(q).toContain("case:yes")
    expect(q).toContain("regex:/\\bMyFn\\b/")
    expect(q).toContain("lang:go")
  })
})
