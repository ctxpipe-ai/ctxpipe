function normalizePathValue(value: string): string {
  let normalized = value.trim()
  if (normalized.startsWith("./")) normalized = normalized.slice(2)
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1)
  return normalized
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function globToRegExp(glob: string): RegExp {
  let pattern = "^"
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === "*") {
      const next = glob[i + 1]
      if (next === "*") {
        pattern += ".*"
        i += 1
      } else {
        pattern += "[^/]*"
      }
      continue
    }
    if (char === "?") {
      pattern += "[^/]"
      continue
    }
    pattern += escapeRegex(char)
  }
  pattern += "$"
  return new RegExp(pattern)
}

function splitDir(path: string): string {
  const idx = path.lastIndexOf("/")
  if (idx === -1) return "./"
  return path.slice(0, idx)
}

export function packageRootsFromPaths(
  allPaths: string[],
  markerFiles: Set<string>,
): string[] {
  const roots = new Set<string>()
  for (const filePath of allPaths) {
    const normalized = normalizePathValue(filePath)
    if (!normalized) continue
    const name = normalized.includes("/")
      ? normalized.slice(normalized.lastIndexOf("/") + 1)
      : normalized
    if (!markerFiles.has(name)) continue
    roots.add(splitDir(normalized))
  }
  return Array.from(roots).sort()
}

export function expandWorkspaceGlobs(input: {
  patterns: string[]
  candidateRoots: string[]
}): {
  roots: string[]
  unresolvedPatterns: string[]
} {
  const roots = new Set<string>()
  const unresolvedPatterns: string[] = []

  for (const rawPattern of input.patterns) {
    const pattern = normalizePathValue(rawPattern)
    if (!pattern) continue
    const hasGlob = /[*?]/.test(pattern)
    const matcher = hasGlob ? globToRegExp(pattern) : null
    const matched = input.candidateRoots.filter((candidate) =>
      matcher ? matcher.test(candidate) : candidate === pattern,
    )
    for (const root of matched) roots.add(root)
    if (matched.length === 0) unresolvedPatterns.push(rawPattern)
  }

  return {
    roots: Array.from(roots).sort(),
    unresolvedPatterns,
  }
}
