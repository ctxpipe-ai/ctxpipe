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

/**
 * Returns the Workspace file path for a link href that the chat agent wrote,
 * or null. It removes a `file://` prefix, the sandbox repository root, a
 * `#L12` or `#L12-L20` fragment, and a `:12` or `:12:5` suffix first.
 */
export function workspaceFilePathFromHref(href: string): string | null {
  const cleaned = href
    .trim()
    .replace(/^file:\/\//i, "")
    .replace(/(?<=.)#.*$/, "")
    .replace(/(?::\d+){1,2}$/, "")
    .replace(/^\/workspace\//, "")
  return workspaceFilePath(cleaned)
}

/**
 * Returns the path of the file in the tree that a chat answer means, or null.
 * An exact path in the tree wins. A name with no folder matches the one tree
 * file that has this name. No match, or more than one, gives null.
 */
export function resolveTreeFilePath(
  path: string,
  treePaths: ReadonlySet<string>,
): string | null {
  if (treePaths.has(path)) return path
  if (path.includes("/")) return null
  let found: string | null = null
  for (const candidate of treePaths) {
    if (candidate.split("/").at(-1) !== path) continue
    if (found) return null
    found = candidate
  }
  return found
}
