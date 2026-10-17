/** File extensions that make a name with no folder a file path, such as `package.json`. */
const knownExtensions = new Set([
  "c",
  "cjs",
  "cpp",
  "cs",
  "css",
  "go",
  "graphql",
  "h",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "lock",
  "md",
  "mdx",
  "mjs",
  "php",
  "prisma",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "yaml",
  "yml",
])

/**
 * Returns the repository-relative file path in chat text (inline code or a
 * link href), or null. The check is conservative: a false link opens a file
 * that is not there, so text that is not clearly a file path stays as text.
 */
export function workspaceFilePath(text: string): string | null {
  const path = text.trim().replace(/^\.\//, "")
  // No spaces, URL schemes, line suffixes, fragments, or backslashes.
  if (!/^[\w.@+\-/[\]()$]+$/.test(path)) return null
  const segments = path.split("/")
  if (segments.some((segment) => segment === "" || segment === "..")) {
    return null
  }
  const name = segments.at(-1) ?? ""
  const extension = /\.([A-Za-z][A-Za-z0-9]*)$/.exec(name)?.[1]
  if (!extension) return null
  if (segments.length > 1) return path
  // A name with no folder: a known extension, and not a product name such as `Node.js`.
  if (!knownExtensions.has(extension.toLowerCase())) return null
  if (/^[A-Z][a-z]*\.js$/.test(name)) return null
  return path
}
