/**
 * Build Zoekt query strings for symbol-style navigation (see Zoekt query_syntax.md).
 */

/** Escape symbol text for use inside sym:"..." quoted strings. */
export function escapeZoektSymQuoted(symbol: string): string {
  return symbol.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** Escape for a literal substring inside Zoekt regex:/.../ */
export function escapeZoektRegexLiteral(symbol: string): string {
  return symbol.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}

/**
 * Zoekt lang: filter clause. TypeScript/JavaScript families OR together like Sourcebot.
 */
export function languageZoektClause(language: string): string {
  const key = language.trim().toLowerCase()
  if (
    key === "typescript" ||
    key === "ts" ||
    key === "tsx" ||
    key === "typescriptreact"
  ) {
    return "(lang:typescript or lang:tsx or lang:javascript or lang:jsx)"
  }
  if (key === "javascript" || key === "js" || key === "jsx") {
    return "(lang:javascript or lang:jsx or lang:typescript or lang:tsx)"
  }

  const aliases: Record<string, string> = {
    go: "go",
    golang: "go",
    python: "python",
    py: "python",
    rust: "rust",
    java: "java",
    kotlin: "kotlin",
    kt: "kotlin",
    ruby: "ruby",
    rb: "ruby",
    php: "php",
    c: "c",
    cpp: "cpp",
    "c++": "cpp",
    cxx: "cpp",
    csharp: "csharp",
    cs: "csharp",
    "c#": "csharp",
    swift: "swift",
    scala: "scala",
    elixir: "elixir",
    ex: "elixir",
    erlang: "erlang",
    dart: "dart",
    vue: "vue",
    svelte: "svelte",
    zig: "zig",
    lua: "lua",
    perl: "perl",
    r: "r",
    matlab: "matlab",
    shell: "sh",
    sh: "sh",
    bash: "bash",
    zsh: "zsh",
    dockerfile: "dockerfile",
    makefile: "makefile",
    hcl: "hcl",
    terraform: "hcl",
  }

  const normalized = aliases[key] ?? key.replace(/\s+/g, "").toLowerCase()
  if (!normalized) return ""
  return `lang:${normalized}`
}

/** Symbol definition search: Zoekt sym: index (requires ctags at index time). */
export function buildSymbolDefinitionQuery(symbol: string, language: string): string {
  const trimmed = symbol.trim()
  if (!trimmed) {
    throw new Error("symbol must be non-empty")
  }
  const sym = escapeZoektSymQuoted(trimmed)
  const lang = languageZoektClause(language)
  const parts = [`sym:"${sym}"`]
  if (lang) parts.push(lang)
  return parts.join(" ")
}

/**
 * Heuristic references: word-boundary content regexp (not compiler-accurate refs).
 */
export function buildSymbolReferencesQuery(symbol: string, language: string): string {
  const trimmed = symbol.trim()
  if (!trimmed) {
    throw new Error("symbol must be non-empty")
  }
  const body = escapeZoektRegexLiteral(trimmed)
  const lang = languageZoektClause(language)
  const parts = [`case:yes`, `regex:/\\b${body}\\b/`]
  if (lang) parts.push(lang)
  return parts.join(" ")
}
