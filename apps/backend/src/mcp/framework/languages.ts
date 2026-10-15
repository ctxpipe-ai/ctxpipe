/**
 * Languages of code files, by file extension. The key is the lower-case
 * name that a caller gives; `name` is the name that a result shows.
 */
const LANGUAGES: Record<string, { name: string; extensions: string[] }> = {
  typescript: { name: "TypeScript", extensions: ["ts", "tsx", "mts", "cts"] },
  javascript: { name: "JavaScript", extensions: ["js", "jsx", "mjs", "cjs"] },
  python: { name: "Python", extensions: ["py", "pyi"] },
  go: { name: "Go", extensions: ["go"] },
  rust: { name: "Rust", extensions: ["rs"] },
  java: { name: "Java", extensions: ["java"] },
  kotlin: { name: "Kotlin", extensions: ["kt", "kts"] },
  scala: { name: "Scala", extensions: ["scala"] },
  ruby: { name: "Ruby", extensions: ["rb"] },
  csharp: { name: "C#", extensions: ["cs"] },
  c: { name: "C", extensions: ["c", "h"] },
  cpp: { name: "C++", extensions: ["cc", "cpp", "cxx", "hpp", "hh", "h"] },
  swift: { name: "Swift", extensions: ["swift"] },
  php: { name: "PHP", extensions: ["php"] },
}

/** The language keys, for an error message. */
export const LANGUAGE_KEYS = Object.keys(LANGUAGES)

/** Other names that callers give for a language. */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  py: "python",
  golang: "go",
  rs: "rust",
  kt: "kotlin",
  rb: "ruby",
  "c#": "csharp",
  cs: "csharp",
  "c++": "cpp",
}

/** The language key of each SCIP indexer scheme. */
const SCIP_SCHEMES: Record<string, string> = {
  "scip-typescript": "typescript",
  "scip-python": "python",
  "scip-go": "go",
  "rust-analyzer": "rust",
  "scip-java": "java",
  semanticdb: "java",
  "scip-ruby": "ruby",
  "scip-dotnet": "csharp",
  "scip-clang": "cpp",
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase()
}

function keyOfPath(path: string): string | null {
  const extension = extensionOf(path)
  if (!extension) return null
  for (const [key, language] of Object.entries(LANGUAGES))
    if (language.extensions.includes(extension)) return key
  return null
}

/** The language of a file path, as a result shows it, or null. */
export function languageOfPath(path: string): string | null {
  const key = keyOfPath(path)
  return key ? (LANGUAGES[key]?.name ?? null) : null
}

/** The language key of a name that a caller gives, or null when unknown. */
export function languageKey(language: string): string | null {
  const lower = language.trim().toLowerCase()
  const key = ALIASES[lower] ?? lower
  return LANGUAGES[key] ? key : null
}

/**
 * True when a file path or a SCIP symbol is in the language. The path
 * decides; without a path, the indexer scheme of the symbol decides.
 */
export function inLanguage(
  key: string,
  item: { path?: string; symbol?: string },
): boolean {
  if (item.path) {
    // TypeScript indexes JavaScript too: the extension decides.
    const pathKey = keyOfPath(item.path)
    // A `.h` header can be C or C++: it is in both.
    if (extensionOf(item.path) === "h" && (key === "c" || key === "cpp"))
      return true
    if (pathKey) return pathKey === key
  }
  const scheme = item.symbol?.split(" ", 1)[0]
  return scheme !== undefined && SCIP_SCHEMES[scheme] === key
}
