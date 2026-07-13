import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { repoPathMatchesPartialScan } from "./partialIngestionScope.js"

export type DeterministicDetectionSignal =
  | "manifest_dependency"
  | "lock_or_config"
  | "import_usage"
  | "framework_marker"

export type DeterministicLibraryCandidate = {
  root: string
  name: string
  category?: string
  confidence: number
  evidence: string[]
  detectionSignals: DeterministicDetectionSignal[]
  manifestPath?: string
  importPath?: string
  categorySource: "map" | "manifest" | "import"
  scoreBreakdown: {
    manifestDependency: number
    corroboration: number
    importUsage: number
    total: number
  }
}

export type DeterministicLibrariesResult = {
  accepted: DeterministicLibraryCandidate[]
  ambiguous: DeterministicLibraryCandidate[]
  unresolvedRoots: string[]
  rootsResolvedDeterministically: string[]
  rootsNeedingLlm: string[]
  manifestFilesChecked: number
  manifestParseFailures: number
}

type LibraryAlias = {
  canonicalName: string
  aliases: string[]
  category?: string
  importTokens: string[]
  markerPatterns?: RegExp[]
}

type CandidateAccumulator = {
  root: string
  name: string
  category?: string
  categorySource: "map" | "manifest" | "import"
  manifestPath?: string
  importPath?: string
  scoreManifestDependency: number
  scoreCorroboration: number
  scoreImportUsage: number
  detectionSignals: Set<DeterministicDetectionSignal>
  evidence: string[]
}

const MANIFEST_SCORE = 0.55
const CORROBORATION_SCORE = 0.2
const IMPORT_SCORE = 0.25
const ACCEPTED_THRESHOLD = 0.85
const AMBIGUOUS_THRESHOLD = 0.6
const MAX_IMPORT_FILES_PER_ROOT = 140

const ROOT_MANIFEST_BASENAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gemfile",
  "composer.json",
  "cargo.toml",
  "mix.exs",
  "package.swift",
])

const LOCK_OR_CONFIG_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "pipfile.lock",
  "go.sum",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "drizzle.config.ts",
  "drizzle.config.js",
  "drizzle.config.mts",
  "drizzle.config.mjs",
  "drizzle.config.cts",
  "drizzle.config.cjs",
])

const SOURCE_CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".rs",
  ".ex",
  ".exs",
  ".swift",
])

const LIBRARY_ALIASES: LibraryAlias[] = [
  {
    canonicalName: "Prisma",
    aliases: ["prisma", "@prisma/client"],
    category: "ORM",
    importTokens: ["prisma", "@prisma/client"],
  },
  {
    canonicalName: "Drizzle",
    aliases: ["drizzle", "drizzle-orm"],
    category: "ORM",
    importTokens: ["drizzle-orm", "drizzle-kit"],
    markerPatterns: [/drizzle\s*\(/i, /drizzle\.config/i],
  },
  {
    canonicalName: "TypeORM",
    aliases: ["typeorm"],
    category: "ORM",
    importTokens: ["typeorm"],
  },
  {
    canonicalName: "Sequelize",
    aliases: ["sequelize"],
    category: "ORM",
    importTokens: ["sequelize"],
  },
  {
    canonicalName: "Mongoose",
    aliases: ["mongoose"],
    category: "ORM",
    importTokens: ["mongoose"],
  },
  {
    canonicalName: "Express",
    aliases: ["express"],
    category: "HTTP",
    importTokens: ["express"],
  },
  {
    canonicalName: "Hono",
    aliases: ["hono"],
    category: "HTTP",
    importTokens: ["hono"],
    markerPatterns: [/new\s+Hono\s*\(/, /createRoute\s*\(/, /\.openapi\s*\(/i],
  },
  {
    canonicalName: "Fastify",
    aliases: ["fastify"],
    category: "HTTP",
    importTokens: ["fastify"],
  },
  {
    canonicalName: "Next.js",
    aliases: ["next", "next.js"],
    category: "HTTP",
    importTokens: ["next", "next/server"],
  },
  {
    canonicalName: "FastAPI",
    aliases: ["fastapi", "fast-api"],
    category: "HTTP",
    importTokens: ["fastapi"],
  },
  {
    canonicalName: "Flask",
    aliases: ["flask"],
    category: "HTTP",
    importTokens: ["flask"],
  },
  {
    canonicalName: "Django",
    aliases: ["django"],
    category: "HTTP",
    importTokens: ["django"],
  },
  {
    canonicalName: "Better Auth",
    aliases: ["better-auth"],
    category: "auth",
    importTokens: ["better-auth"],
    markerPatterns: [/betterAuth\s*\(/],
  },
  {
    canonicalName: "Zod",
    aliases: ["zod"],
    category: "validation",
    importTokens: ["zod"],
    markerPatterns: [/\bz\.object\s*\(/, /\bz\.string\s*\(/],
  },
  {
    canonicalName: "ioredis",
    aliases: ["ioredis"],
    category: "cache",
    importTokens: ["ioredis"],
  },
  {
    canonicalName: "Redis",
    aliases: ["redis", "redis-py", "go-redis"],
    category: "cache",
    importTokens: ["redis", "go-redis"],
  },
  {
    canonicalName: "Upstash Redis",
    aliases: ["@upstash/redis"],
    category: "cache",
    importTokens: ["@upstash/redis"],
  },
  {
    canonicalName: "tRPC",
    aliases: ["trpc", "@trpc/server"],
    category: "RPC/API",
    importTokens: ["@trpc/server", "@trpc/client", "@trpc/react-query"],
  },
  {
    canonicalName: "Axios",
    aliases: ["axios"],
    category: "HTTP",
    importTokens: ["axios"],
  },
  {
    canonicalName: "Supabase",
    aliases: ["supabase", "@supabase/supabase-js"],
    category: "auth",
    importTokens: ["@supabase/supabase-js"],
  },
]

const aliasLookup = new Map<string, LibraryAlias>()
for (const alias of LIBRARY_ALIASES) {
  aliasLookup.set(alias.canonicalName.toLowerCase(), alias)
  for (const value of alias.aliases) {
    aliasLookup.set(value.toLowerCase(), alias)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/")
  if (slash === -1) return path
  return path.slice(slash + 1)
}

function withinRoot(path: string, root: string): boolean {
  if (root === "./" || root === ".") return true
  return path === root || path.startsWith(`${root}/`)
}

function clamp01(score: number): number {
  return Math.max(0, Math.min(1, score))
}

function isSourceFile(path: string): boolean {
  const lower = path.toLowerCase()
  for (const ext of SOURCE_CODE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

function parsePackageJsonDependencies(content: string): string[] {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const keys: string[] = []
  const dependencyFields = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]
  for (const field of dependencyFields) {
    const value = parsed[field]
    if (!value || typeof value !== "object") continue
    keys.push(...Object.keys(value as Record<string, unknown>))
  }
  return keys
}

function parseRequirementsDependencies(content: string): string[] {
  const out: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const cleaned = line.split("#")[0]?.trim()
    if (!cleaned) continue
    const token = cleaned.split(/[<>=!~[\];\s]/)[0]?.trim()
    if (token) out.push(token)
  }
  return out
}

function parsePyprojectDependencies(content: string): string[] {
  const out: string[] = []
  const pep621Array = /dependencies\s*=\s*\[([\s\S]*?)\]/g
  for (const match of content.matchAll(pep621Array)) {
    const body = match[1] ?? ""
    for (const item of body.matchAll(/["']([^"']+)["']/g)) {
      const raw = item[1]?.trim()
      if (!raw) continue
      const token = raw.split(/[<>=!~[\];\s]/)[0]?.trim()
      if (token) out.push(token)
    }
  }

  const poetryBlock = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/g
  for (const match of content.matchAll(poetryBlock)) {
    const body = match[1] ?? ""
    for (const line of body.split(/\r?\n/)) {
      const dep = line.split("=")[0]?.trim()
      if (!dep || dep.startsWith("#") || dep === "python") continue
      out.push(dep.replace(/^['"]|['"]$/g, ""))
    }
  }
  return out
}

function parseGoModDependencies(content: string): string[] {
  const out: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (
      !trimmed ||
      trimmed === "require (" ||
      trimmed === ")" ||
      trimmed.startsWith("module ") ||
      trimmed.startsWith("go ")
    ) {
      continue
    }
    if (trimmed.startsWith("require ")) {
      const dep = trimmed.replace(/^require\s+/, "").split(/\s+/)[0]
      if (dep) out.push(dep)
      continue
    }
    const dep = trimmed.split(/\s+/)[0]
    if (dep && !dep.startsWith("//")) out.push(dep)
  }
  return out
}

function parsePomDependencies(content: string): string[] {
  const out: string[] = []
  for (const match of content.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
    const dep = match[1]?.trim()
    if (dep) out.push(dep)
  }
  return out
}

function parseGradleDependencies(content: string): string[] {
  const out: string[] = []
  for (const match of content.matchAll(/["']([^"']+:[^"']+)["']/g)) {
    const notation = match[1] ?? ""
    const parts = notation.split(":")
    if (parts.length >= 2) {
      out.push(parts[1] ?? "")
    }
  }
  return out.filter(Boolean)
}

function parseGemfileDependencies(content: string): string[] {
  const out: string[] = []
  for (const match of content.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) {
    const dep = match[1]?.trim()
    if (dep) out.push(dep)
  }
  return out
}

function parseComposerDependencies(content: string): string[] {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const out: string[] = []
  for (const field of ["require", "require-dev"]) {
    const section = parsed[field]
    if (!section || typeof section !== "object") continue
    out.push(...Object.keys(section as Record<string, unknown>))
  }
  return out
}

function parseCargoDependencies(content: string): string[] {
  const out: string[] = []
  const dependencyBlocks = [
    /\[dependencies\]([\s\S]*?)(?:\n\[|$)/g,
    /\[dev-dependencies\]([\s\S]*?)(?:\n\[|$)/g,
  ]
  for (const block of dependencyBlocks) {
    for (const match of content.matchAll(block)) {
      const body = match[1] ?? ""
      for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const dep = trimmed.split("=")[0]?.trim()
        if (dep) out.push(dep)
      }
    }
  }
  return out
}

function parseMixDependencies(content: string): string[] {
  const out: string[] = []
  for (const match of content.matchAll(/\{\s*:([a-zA-Z0-9_]+)\s*,/g)) {
    const dep = match[1]?.trim()
    if (dep) out.push(dep)
  }
  return out
}

function parsePackageSwiftDependencies(content: string): string[] {
  const out: string[] = []
  for (const match of content.matchAll(/\.package\([^)]*url:\s*["']([^"']+)["']/g)) {
    const url = match[1] ?? ""
    const last = url.split("/").pop()?.replace(/\.git$/i, "")
    if (last) out.push(last)
  }
  return out
}

function parseDependenciesFromManifest(
  path: string,
  content: string,
): { dependencies: string[]; parsed: boolean } {
  const file = basename(path).toLowerCase()
  try {
    if (file === "package.json") {
      return { dependencies: parsePackageJsonDependencies(content), parsed: true }
    }
    if (file === "requirements.txt") {
      return { dependencies: parseRequirementsDependencies(content), parsed: true }
    }
    if (file === "pyproject.toml") {
      return { dependencies: parsePyprojectDependencies(content), parsed: true }
    }
    if (file === "go.mod") {
      return { dependencies: parseGoModDependencies(content), parsed: true }
    }
    if (file === "pom.xml") {
      return { dependencies: parsePomDependencies(content), parsed: true }
    }
    if (file === "build.gradle" || file === "build.gradle.kts") {
      return { dependencies: parseGradleDependencies(content), parsed: true }
    }
    if (file === "gemfile") {
      return { dependencies: parseGemfileDependencies(content), parsed: true }
    }
    if (file === "composer.json") {
      return { dependencies: parseComposerDependencies(content), parsed: true }
    }
    if (file === "cargo.toml") {
      return { dependencies: parseCargoDependencies(content), parsed: true }
    }
    if (file === "mix.exs") {
      return { dependencies: parseMixDependencies(content), parsed: true }
    }
    if (file === "package.swift") {
      return { dependencies: parsePackageSwiftDependencies(content), parsed: true }
    }
    return { dependencies: [], parsed: true }
  } catch {
    return { dependencies: [], parsed: false }
  }
}

export function normalizeLibraryName(name: string): string {
  const key = name.trim().toLowerCase()
  if (!key) return name
  return aliasLookup.get(key)?.canonicalName ?? name
}

export function scoreLibraryCandidate(input: {
  hasManifestDependency: boolean
  hasCorroboration: boolean
  hasImportUsage: boolean
}): {
  confidence: number
  scoreBreakdown: DeterministicLibraryCandidate["scoreBreakdown"]
} {
  const manifestDependency = input.hasManifestDependency ? MANIFEST_SCORE : 0
  const corroboration = input.hasCorroboration ? CORROBORATION_SCORE : 0
  const importUsage = input.hasImportUsage ? IMPORT_SCORE : 0
  const total = clamp01(manifestDependency + corroboration + importUsage)
  return {
    confidence: total,
    scoreBreakdown: {
      manifestDependency,
      corroboration,
      importUsage,
      total,
    },
  }
}

function categorizeCandidate(candidate: DeterministicLibraryCandidate):
  | "accepted"
  | "ambiguous"
  | "rejected" {
  if (candidate.confidence >= ACCEPTED_THRESHOLD) return "accepted"
  if (candidate.confidence >= AMBIGUOUS_THRESHOLD) return "ambiguous"
  return "rejected"
}

function hasImportSignalForAlias(content: string, alias: LibraryAlias): boolean {
  for (const token of alias.importTokens) {
    const escaped = escapeRegExp(token)
    const stringLiteralRef = new RegExp(`["']${escaped}(?:["'/])`, "i")
    if (stringLiteralRef.test(content)) return true
    const importRef = new RegExp(
      `\\b(?:import|from|require\\s*\\(|use)\\b[^\\n]*${escaped}`,
      "i",
    )
    if (importRef.test(content)) return true
  }
  return false
}

function hasFrameworkMarkerForAlias(content: string, alias: LibraryAlias): boolean {
  for (const pattern of alias.markerPatterns ?? []) {
    if (pattern.test(content)) return true
  }
  return false
}

function toCandidateOutput(
  candidate: CandidateAccumulator,
): DeterministicLibraryCandidate {
  const scored = scoreLibraryCandidate({
    hasManifestDependency: candidate.scoreManifestDependency > 0,
    hasCorroboration: candidate.scoreCorroboration > 0,
    hasImportUsage: candidate.scoreImportUsage > 0,
  })
  return {
    root: candidate.root,
    name: candidate.name,
    category: candidate.category,
    confidence: scored.confidence,
    evidence: candidate.evidence,
    detectionSignals: Array.from(candidate.detectionSignals),
    manifestPath: candidate.manifestPath,
    importPath: candidate.importPath,
    categorySource: candidate.categorySource,
    scoreBreakdown: scored.scoreBreakdown,
  }
}

export async function detectLibrariesDeterministic(input: {
  repositoryId: string
  orgId: string
  roots: string[]
  scanPaths?: string[]
}): Promise<DeterministicLibrariesResult> {
  const accepted: DeterministicLibraryCandidate[] = []
  const ambiguous: DeterministicLibraryCandidate[] = []
  const unresolvedRoots: string[] = []
  let manifestFilesChecked = 0
  let manifestParseFailures = 0

  for (const root of input.roots) {
    const rootPrefix = root === "./" || root === "." ? "" : root
    const allRootPaths = await listFilesRecursive(
      input.repositoryId,
      input.orgId,
      rootPrefix,
    )
    const filteredRootPaths =
      input.scanPaths && input.scanPaths.length > 0
        ? allRootPaths.filter((path) => repoPathMatchesPartialScan(path, input.scanPaths ?? []))
        : allRootPaths

    const manifests = filteredRootPaths.filter((path) =>
      ROOT_MANIFEST_BASENAMES.has(basename(path).toLowerCase()),
    )
    const corroborationPaths = new Set(
      filteredRootPaths.filter((path) =>
        LOCK_OR_CONFIG_BASENAMES.has(basename(path).toLowerCase()),
      ),
    )
    const sourceFiles = filteredRootPaths
      .filter((path) => isSourceFile(path))
      .slice(0, MAX_IMPORT_FILES_PER_ROOT)

    const fetchTargets = new Set<string>([...manifests, ...sourceFiles])
    if (fetchTargets.size === 0) {
      unresolvedRoots.push(root)
      continue
    }

    const contents = await fetchFiles(input.repositoryId, input.orgId, [...fetchTargets])
    const candidates = new Map<string, CandidateAccumulator>()

    for (const manifestPath of manifests) {
      const content = contents[manifestPath]
      if (content === undefined) continue
      manifestFilesChecked += 1
      const parsed = parseDependenciesFromManifest(manifestPath, content)
      if (!parsed.parsed) {
        manifestParseFailures += 1
        continue
      }
      for (const dependency of parsed.dependencies) {
        const mapped = aliasLookup.get(dependency.toLowerCase())
        if (!mapped) continue
        const dedupKey = `${root}::${mapped.canonicalName}`
        const existing = candidates.get(dedupKey)
        if (existing) {
          existing.scoreManifestDependency = MANIFEST_SCORE
          existing.detectionSignals.add("manifest_dependency")
          existing.evidence.push(`manifest:${manifestPath}:${dependency}`)
          if (!existing.manifestPath) existing.manifestPath = manifestPath
          continue
        }
        candidates.set(dedupKey, {
          root,
          name: mapped.canonicalName,
          category: mapped.category,
          categorySource: mapped.category ? "map" : "manifest",
          manifestPath,
          scoreManifestDependency: MANIFEST_SCORE,
          scoreCorroboration: 0,
          scoreImportUsage: 0,
          detectionSignals: new Set(["manifest_dependency"]),
          evidence: [`manifest:${manifestPath}:${dependency}`],
        })
      }
    }

    if (candidates.size === 0) {
      unresolvedRoots.push(root)
      continue
    }

    const hasCorroborationInRoot = [...corroborationPaths].some((path) =>
      withinRoot(path, root),
    )
    if (hasCorroborationInRoot) {
      for (const candidate of candidates.values()) {
        candidate.scoreCorroboration = CORROBORATION_SCORE
        candidate.detectionSignals.add("lock_or_config")
        candidate.evidence.push("corroboration:lock_or_config")
      }
    }

    for (const sourcePath of sourceFiles) {
      const sourceContent = contents[sourcePath]
      if (sourceContent === undefined) continue
      for (const candidate of candidates.values()) {
        const alias = aliasLookup.get(candidate.name.toLowerCase())
        if (!alias) continue
        if (
          candidate.scoreImportUsage === 0 &&
          hasImportSignalForAlias(sourceContent, alias)
        ) {
          candidate.scoreImportUsage = IMPORT_SCORE
          candidate.detectionSignals.add("import_usage")
          candidate.importPath = sourcePath
          candidate.evidence.push(`import:${sourcePath}`)
          candidate.categorySource = candidate.category ? candidate.categorySource : "import"
        }
        if (hasFrameworkMarkerForAlias(sourceContent, alias)) {
          candidate.scoreCorroboration = CORROBORATION_SCORE
          candidate.detectionSignals.add("framework_marker")
          candidate.evidence.push(`marker:${sourcePath}`)
        }
      }
    }

    let rootAccepted = 0
    let rootAmbiguous = 0
    for (const candidate of candidates.values()) {
      const output = toCandidateOutput(candidate)
      const bucket = categorizeCandidate(output)
      if (bucket === "accepted") {
        accepted.push(output)
        rootAccepted += 1
      } else if (bucket === "ambiguous") {
        ambiguous.push(output)
        rootAmbiguous += 1
      }
    }

    if (rootAccepted === 0 && rootAmbiguous === 0) {
      unresolvedRoots.push(root)
    }
  }

  const rootsResolvedDeterministically = Array.from(new Set(accepted.map((c) => c.root)))
  const rootsNeedingLlm = Array.from(
    new Set([
      ...unresolvedRoots,
      ...ambiguous.map((c) => c.root),
    ]),
  ).sort()

  return {
    accepted,
    ambiguous,
    unresolvedRoots: Array.from(new Set(unresolvedRoots)).sort(),
    rootsResolvedDeterministically,
    rootsNeedingLlm,
    manifestFilesChecked,
    manifestParseFailures,
  }
}
