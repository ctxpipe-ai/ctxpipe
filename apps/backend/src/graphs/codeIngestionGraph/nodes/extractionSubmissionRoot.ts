/**
 * Resolves which workspace `roots` entry owns a submitted path for extraction post-processors.
 * Keeps monorepo + `./` combinations from double-counting the same submission under `svc:…:./`
 * and a more specific root.
 */

export function pathMatchesRoot(path: string, root: string): boolean {
  if (root === "./") return true
  return path.startsWith(`${root}/`) || path === root
}

/** Longest matching root string, or null if none. */
export function findMatchingRoot(path: string, roots: string[]): string | null {
  const matching = roots.filter((r) => pathMatchesRoot(path, r))
  if (matching.length === 0) return null
  return matching.reduce((a, b) => (a.length >= b.length ? a : b))
}

/**
 * Picks the service root for a submission path. Returns null when the path should not be
 * attributed (e.g. only matches `./` while other roots exist — unknown monorepo path).
 */
export function resolveSubmissionRoot(
  path: string,
  roots: string[],
): string | null {
  const resolved = findMatchingRoot(path, roots)
  if (resolved === null) return null
  const hasNonTrivialRoot = roots.some((r) => r !== "./")
  if (hasNonTrivialRoot && resolved === "./" && path !== "./" && path !== ".") {
    return null
  }
  return resolved
}
