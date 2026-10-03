import type { HydrateUnit } from "./hydrate.js"
import { parseSimpleFrontMatter } from "./layout.js"

export const RENAME_SIMILARITY_THRESHOLD = 0.5

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  )
}

export function diceSimilarity(left: string, right: string): number {
  const a = tokens(left)
  const b = tokens(right)
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  for (const token of a) {
    if (b.has(token)) overlap += 1
  }
  return (2 * overlap) / (a.size + b.size)
}

export function renameSimilarity(input: {
  fromPath: string
  toPath: string
  fromContent?: string
  toContent?: string
}): number {
  const pathScore = diceSimilarity(input.fromPath, input.toPath)
  if (input.fromContent == null || input.toContent == null) return pathScore
  const contentScore = diceSimilarity(input.fromContent, input.toContent)
  return Math.max(pathScore, contentScore)
}

export function pairRenames(input: {
  previousPaths: readonly string[]
  currentPaths: readonly string[]
  previousContent?: ReadonlyMap<string, string>
  currentContent?: ReadonlyMap<string, string>
  threshold?: number
}): Array<{ from: string; to: string }> {
  const threshold = input.threshold ?? RENAME_SIMILARITY_THRESHOLD
  const current = new Set(input.currentPaths)
  const previous = new Set(input.previousPaths)
  const deleted = input.previousPaths.filter((path) => !current.has(path))
  const added = input.currentPaths.filter((path) => !previous.has(path))
  const pairs: Array<{ from: string; to: string; score: number }> = []
  for (const from of deleted) {
    for (const to of added) {
      const score = renameSimilarity({
        fromPath: from,
        toPath: to,
        fromContent: input.previousContent?.get(from),
        toContent: input.currentContent?.get(to),
      })
      if (score >= threshold) pairs.push({ from, to, score })
    }
  }
  const manyToOne = new Set(
    added.filter((to) => pairs.filter((pair) => pair.to === to).length > 1),
  )
  pairs.sort((left, right) => right.score - left.score)
  const usedFrom = new Set<string>()
  const usedTo = new Set<string>()
  const unique: Array<{ from: string; to: string }> = []
  for (const pair of pairs) {
    if (manyToOne.has(pair.to)) continue
    if (usedFrom.has(pair.from) || usedTo.has(pair.to)) continue
    usedFrom.add(pair.from)
    usedTo.add(pair.to)
    unique.push({ from: pair.from, to: pair.to })
  }
  return unique
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/")
  return idx === -1 ? "" : path.slice(0, idx)
}

export function relativeLink(fromFile: string, toFile: string): string {
  const fromParts = dirname(fromFile).split("/").filter(Boolean)
  const toParts = toFile.split("/").filter(Boolean)
  let i = 0
  while (
    i < fromParts.length &&
    i < toParts.length - 1 &&
    fromParts[i] === toParts[i]
  ) {
    i += 1
  }
  const up = fromParts.length - i
  const down = toParts.slice(i)
  return `${"../".repeat(up)}${down.join("/")}`
}

function rewriteLinks(
  content: string,
  replacements: Map<string, string>,
): string {
  let next = content
  for (const [from, to] of replacements) {
    next = next.split(from).join(to)
  }
  return next
}

export function renameRewriteRemainder(input: {
  previousPaths: readonly string[]
  currentPaths: readonly string[]
  units: readonly HydrateUnit[]
  previousContent?: ReadonlyMap<string, string>
  currentContent?: ReadonlyMap<string, string>
}): number {
  const pairs = pairRenames(input)
  if (pairs.length === 0) return 0
  const oldPaths = new Set(pairs.map((pair) => pair.from))
  return input.units.filter((unit) =>
    unit.links.some(
      (link) =>
        oldPaths.has(link) ||
        [...oldPaths].some((old) => link.includes(old.split("/").pop() ?? "")),
    ),
  ).length
}

export function renameRewriteFiles(input: {
  files: ReadonlyArray<{ path: string; content: string }>
  units: readonly HydrateUnit[]
  previousPaths: readonly string[]
  currentPaths: readonly string[]
  previousContent?: ReadonlyMap<string, string>
  currentContent?: ReadonlyMap<string, string>
}): Array<{ path: string; content: string }> {
  const pairs = pairRenames(input)
  if (pairs.length === 0) return []
  const byPath = new Map(input.files.map((file) => [file.path, file.content]))
  const out: Array<{ path: string; content: string }> = []
  for (const file of input.files) {
    const parsed = parseSimpleFrontMatter(file.content)
    if (parsed.malformed) continue
    const replacements = new Map<string, string>()
    for (const pair of pairs) {
      const fromRel = relativeLink(file.path, pair.from)
      const toRel = relativeLink(file.path, pair.to)
      if (fromRel !== toRel) replacements.set(fromRel, toRel)
      replacements.set(pair.from, pair.to)
    }
    if (replacements.size === 0) continue
    const content = rewriteLinks(file.content, replacements)
    if (content === file.content) continue
    out.push({ path: file.path, content })
    byPath.set(file.path, content)
  }
  return out
}
