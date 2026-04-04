/**
 * Pure helpers to narrow monorepo roots to those relevant to a partial-ingestion diff.
 */

export type CodeIngestionRename = { from: string; to: string }

/** Strip a leading `./` (repo-relative paths). */
export function stripLeadingDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path
}

/**
 * Normalize a root for prefix matching: strip `./`, trim trailing `/`.
 * `""`, `"."`, and `"./"` all mean repo root (matches every path).
 */
export function normalizeMonorepoRootPrefix(root: string): string {
  let r = stripLeadingDotSlash(root.trim())
  while (r.endsWith("/")) {
    r = r.slice(0, -1)
  }
  if (r === "." || r.length === 0) return ""
  return r
}

/** True if `path` is inside `rootPrefix` (or equals the root folder itself). */
export function pathStartsWithRootPrefix(
  path: string,
  rootPrefix: string,
): boolean {
  const p = stripLeadingDotSlash(path.trim())
  if (rootPrefix.length === 0) return true
  return p === rootPrefix || p.startsWith(`${rootPrefix}/`)
}

function collectDiffPaths(
  changedPaths: string[] | undefined,
  deletedPaths: string[] | undefined,
  renames: CodeIngestionRename[] | undefined,
): string[] {
  const out: string[] = []
  if (changedPaths) out.push(...changedPaths)
  if (deletedPaths) out.push(...deletedPaths)
  if (renames) {
    for (const r of renames) {
      out.push(r.from, r.to)
    }
  }
  return out
}

/**
 * Returns roots whose prefix intersects any changed/deleted/renamed path.
 * Repo root (`""`/`./`) is always included when present in `roots` because it matches all paths.
 */
export function narrowRootsForPartialDiff(
  roots: string[],
  changedPaths: string[] | undefined,
  deletedPaths: string[] | undefined,
  renames: CodeIngestionRename[] | undefined,
): string[] {
  const diffPaths = collectDiffPaths(changedPaths, deletedPaths, renames)
  if (roots.length === 0 || diffPaths.length === 0) return roots

  const normalizedRoots = roots.map((r) => ({
    raw: r,
    prefix: normalizeMonorepoRootPrefix(r),
  }))

  const narrowed = normalizedRoots.filter(({ prefix }) => {
    if (prefix.length === 0) return true
    return diffPaths.some((p) => pathStartsWithRootPrefix(p, prefix))
  })

  return narrowed.map((r) => r.raw)
}
