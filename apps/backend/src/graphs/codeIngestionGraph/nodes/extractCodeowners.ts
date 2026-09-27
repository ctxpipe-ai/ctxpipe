import {
  fetchFiles,
  globFiles,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { buildEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import { parseGithubTeamOwner } from "../../../domain/codeIngestion/referenceResolver.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import { packageRootsFromObjects } from "./linkLocatedPaths.js"
import { normalizeMonorepoRootPrefix } from "./narrowRootsForPartialDiff.js"
import { shouldSkipCodeExtractorForPartialDiff } from "./partialIngestionScope.js"

/** GitHub resolves CODEOWNERS from these locations, in this order. */
export const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const

export type CodeownersRule = { pattern: string; owners: string[] }

export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = []
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim()
    if (line.length === 0) continue
    const [pattern, ...owners] = line.split(/\s+/)
    if (!pattern) continue
    rules.push({ pattern, owners })
  }
  return rules
}

function globToRegex(glob: string): RegExp {
  let out = ""
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*"
        i += 1
      } else {
        out += "[^/]*"
      }
    } else if (ch === "?") {
      out += "[^/]"
    } else if (ch && /[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * Does a CODEOWNERS pattern cover a package root directory? Directory
 * semantics only: file globs (`*.ts`, `docs/*.md`) never own a package. `*`
 * and `/` cover every root including the repository root; other patterns are
 * matched against the root and each of its ancestors, anchored when the
 * pattern starts with `/` and at any depth otherwise (gitignore rules).
 */
export function codeownersPatternCoversRoot(
  pattern: string,
  root: string,
): boolean {
  const normalizedRoot = normalizeMonorepoRootPrefix(root)
  let glob = pattern.trim()
  if (glob === "*" || glob === "/" || glob === "**" || glob === "/**")
    return true
  if (normalizedRoot.length === 0) return false
  const anchored = glob.startsWith("/")
  glob = glob
    .replace(/^\//, "")
    .replace(/\/\*\*$/, "")
    .replace(/\/$/, "")
  if (glob.length === 0) return true
  const lastSegment = glob.split("/").pop() ?? ""
  if (lastSegment !== "**" && /\.[A-Za-z0-9]+$/.test(lastSegment)) return false

  const regex = globToRegex(glob)
  const segments = normalizedRoot.split("/")
  const ancestors = segments.map((_, index) =>
    segments.slice(0, index + 1).join("/"),
  )
  if (anchored) return ancestors.some((candidate) => regex.test(candidate))
  return ancestors.some((candidate) => {
    const parts = candidate.split("/")
    return parts.some((_, start) => regex.test(parts.slice(start).join("/")))
  })
}

/** Last matching rule wins, per CODEOWNERS semantics. */
export function owningRuleForRoot(
  rules: CodeownersRule[],
  root: string,
): CodeownersRule | null {
  let owner: CodeownersRule | null = null
  for (const rule of rules) {
    if (codeownersPatternCoversRoot(rule.pattern, root)) owner = rule
  }
  return owner
}

/**
 * Source-repository extractor (ADR-033): `Team OWNS Service|App|Library` from
 * CODEOWNERS team owners. Individual and email owners are ignored (no Person
 * kind yet). Runs per package root; Team objects dedupe by key.
 */
export async function extractCodeowners(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  if (shouldSkipCodeExtractorForPartialDiff(state)) return {}

  const packages = packageRootsFromObjects(state.extractedObjects ?? []).filter(
    (entry) => entry.repositoryId === state.repositoryId,
  )
  if (packages.length === 0) return {}

  // Exact-path globs: `**` does not reliably descend into `.github/`.
  const globbed = await Promise.all(
    CODEOWNERS_PATHS.map((pattern) =>
      globFiles(state.repositoryId, state.orgId, { pattern, onlyFiles: true }),
    ),
  )
  const present = new Set(
    globbed.flatMap((result) =>
      result.entries
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.path.replace(/^\.\//, "")),
    ),
  )
  const codeownersPath = CODEOWNERS_PATHS.find((path) => present.has(path))
  if (!codeownersPath) return {}

  const contents = await fetchFiles(state.repositoryId, state.orgId, [
    codeownersPath,
  ])
  const content = contents[codeownersPath]
  if (!content) return {}
  const rules = parseCodeowners(content)
  if (rules.length === 0) return {}

  const teams = new Map<string, ExtractedObject>()
  const claims: ExtractedClaim[] = []
  for (const pkg of packages) {
    const rule = owningRuleForRoot(rules, pkg.root)
    if (!rule) continue
    for (const token of rule.owners) {
      const teamKey = parseGithubTeamOwner(token)
      if (!teamKey) continue
      const [org, slug] = teamKey.slice("team:github:".length).split("/")
      if (!org || !slug) continue
      if (!teams.has(teamKey)) {
        teams.set(teamKey, {
          kind: "Team",
          deduplicationKey: teamKey,
          name: `${org}/${slug}`,
          payload: { key: slug, org, source: "github" },
        })
      }
      claims.push({
        subjectRef: teamKey,
        subjectKind: "Team",
        objectRef: pkg.deduplicationKey,
        objectKind: pkg.kind,
        predicate: "OWNS",
        sourceId: buildEvidenceSourceId({
          extractor: "codeowners",
          repositoryId: state.repositoryId,
          segments: [codeownersPath, "OWNS", pkg.root, `${org}/${slug}`],
          targetHash: state.targetHash,
        }),
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.95,
        provenance: {
          path: codeownersPath,
          pattern: rule.pattern,
          root: pkg.root,
        },
      })
    }
  }

  return { extractedObjects: [...teams.values()], extractedClaims: claims }
}
