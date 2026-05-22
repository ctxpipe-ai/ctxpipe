/** Paths relative to repo root — normalized with forward slashes */
export function githubPushTouchesPath(input: {
  commits?: Array<{
    added?: string[]
    modified?: string[]
    removed?: string[]
  }>
  path: string
}): boolean {
  const paths = new Set<string>()
  for (const c of input.commits ?? []) {
    for (const p of c.added ?? []) paths.add(p)
    for (const p of c.modified ?? []) paths.add(p)
    for (const p of c.removed ?? []) paths.add(p)
  }
  return paths.has(input.path)
}

/**
 * True when commit lists omit `path` entirely — GitHub sometimes delivers incomplete `commits[]`;
 * callers should fall back to compareCommits when this returns true and before/after SHAs exist.
 */
export function githubCommitsMissingPathEntirely(input: {
  commits?: Array<{
    added?: string[]
    modified?: string[]
    removed?: string[]
  }>
  path: string
}): boolean {
  const commits = input.commits ?? []
  if (commits.length === 0) return true
  for (const c of commits) {
    for (const p of c.added ?? []) if (p === input.path) return false
    for (const p of c.modified ?? []) if (p === input.path) return false
    for (const p of c.removed ?? []) if (p === input.path) return false
  }
  return true
}
