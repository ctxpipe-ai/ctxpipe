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
