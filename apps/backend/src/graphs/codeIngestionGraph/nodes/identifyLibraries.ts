/**
 * identifyLibraries extractor
 *
 * Detects architectural libraries (ORM, HTTP client, auth, validation, etc.) used by
 * services in a repository. Uses an LLM agent with list_files, search, and get_file
 * tools to explore package manifests and source code, then produces Library objects
 * and USES_LIBRARY claims (Service → Library).
 *
 * Deduplication: lib:${repositoryId}:${root}:${libraryName}
 * Claim path: subjectRef = svc:${repositoryId}:${root}, objectRef = lib key
 */

import { HumanMessage } from "@langchain/core/messages"
import { mergeConfigs } from "@langchain/core/runnables"
import { getConfig } from "@langchain/langgraph"
import { tool } from "langchain"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../../../auth/context.js"
import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { getLogger } from "../../../observability/logger.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import {
  REPO_EXPLORER_TOOLS_HINT,
  standardRepoExplorerTools,
} from "../../../tools/repoExplorerTools.js"
import { createAgent } from "../../createAgent.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import { resolveSubmissionRoot } from "./extractionSubmissionRoot.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  partialScanPromptSuffix,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

/** Normalize library name to canonical form for deduplication */
function normalizeLibraryName(name: string): string {
  const lower = name.toLowerCase()
  const known: Record<string, string> = {
    prisma: "Prisma",
    drizzle: "Drizzle",
    "drizzle-orm": "Drizzle",
    express: "Express",
    hono: "Hono",
    zod: "Zod",
    "better-auth": "Better Auth",
    ioredis: "ioredis",
    "next.js": "Next.js",
    next: "Next.js",
    fastify: "Fastify",
    "fast-api": "FastAPI",
    fastapi: "FastAPI",
    flask: "Flask",
    django: "Django",
    trpc: "tRPC",
    "@trpc/server": "tRPC",
    axios: "Axios",
    fetch: "fetch",
    "react-query": "TanStack Query",
    "tanstack-query": "TanStack Query",
    "@tanstack/react-query": "TanStack Query",
    mongoose: "Mongoose",
    typeorm: "TypeORM",
    knex: "Knex",
    sequelize: "Sequelize",
    "better-sqlite3": "better-sqlite3",
    redis: "Redis",
    "@upstash/redis": "Upstash Redis",
    supabase: "Supabase",
    "@supabase/supabase-js": "Supabase",
  }
  return known[lower] ?? name
}

type SubmittedLibrary = {
  name: string
  path: string
  category?: string
  evidence?: string
  extractionMethod?: "deterministic" | "llm"
}

function createIdentifyLibrariesTools(capturedLibraries: {
  value: SubmittedLibrary[]
}) {
  const submitLibrariesTool = tool(
    async ({ libraries }) => {
      capturedLibraries.value.push(
        ...libraries.map((library) => ({
          ...library,
          extractionMethod: "llm" as const,
        })),
      )
      return `Recorded ${libraries.length} library(ies). Total: ${capturedLibraries.value.length}.`
    },
    {
      name: "submit_libraries",
      description: `Call this when you have discovered one or more architectural libraries used by the codebase. For each library provide name (e.g. Prisma, Drizzle, Express, Hono, Zod, Better Auth, ioredis), path (root or directory where it's used, e.g. apps/web or .), optional category (ORM, HTTP, auth, validation, cache, etc.), and optional evidence (brief description of how you found it). Focus on architectural deps — ORM, HTTP client, auth, validation — not every util.`,
      schema: z.object({
        libraries: z.array(
          z.object({
            name: z
              .string()
              .describe(
                "Library name: Prisma, Drizzle, Express, Hono, Zod, Better Auth, ioredis, etc.",
              ),
            path: z
              .string()
              .describe(
                "Root or directory path where library is used, e.g. apps/web or .",
              ),
            category: z
              .string()
              .optional()
              .describe("Category: ORM, HTTP, auth, validation, cache, etc."),
            evidence: z
              .string()
              .optional()
              .describe("Brief evidence, e.g. from package.json dependencies"),
          }),
        ),
      }),
    },
  )
  return [...standardRepoExplorerTools, submitLibrariesTool]
}

const ROOT_MANIFEST_FILES = new Set([
  "package.json",
  "Gemfile",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Cargo.toml",
  "composer.json",
  "mix.exs",
  "Package.swift",
])

const DEPENDENCY_LIBRARY_MAP: Record<string, { name: string; category: string }> = {
  prisma: { name: "Prisma", category: "ORM" },
  "drizzle-orm": { name: "Drizzle", category: "ORM" },
  drizzle: { name: "Drizzle", category: "ORM" },
  express: { name: "Express", category: "HTTP" },
  hono: { name: "Hono", category: "HTTP" },
  fastify: { name: "Fastify", category: "HTTP" },
  next: { name: "Next.js", category: "HTTP" },
  "next.js": { name: "Next.js", category: "HTTP" },
  fastapi: { name: "FastAPI", category: "HTTP" },
  flask: { name: "Flask", category: "HTTP" },
  django: { name: "Django", category: "HTTP" },
  rails: { name: "Rails", category: "HTTP" },
  sinatra: { name: "Sinatra", category: "HTTP" },
  "github.com/gofiber/fiber": { name: "Fiber", category: "HTTP" },
  "github.com/go-chi/chi": { name: "Chi", category: "HTTP" },
  "org.springframework.boot": { name: "Spring Boot", category: "HTTP" },
  "spring-boot-starter-web": { name: "Spring Boot", category: "HTTP" },
  axum: { name: "Axum", category: "HTTP" },
  "laravel/framework": { name: "Laravel", category: "HTTP" },
  "symfony/framework-bundle": { name: "Symfony", category: "HTTP" },
  "microsoft.aspnetcore.app": { name: "ASP.NET Core", category: "HTTP" },
  "microsoft.entityframeworkcore": { name: "Entity Framework", category: "ORM" },
  phoenix: { name: "Phoenix", category: "HTTP" },
  ecto: { name: "Ecto", category: "ORM" },
  vapor: { name: "Vapor", category: "HTTP" },
  zod: { name: "Zod", category: "validation" },
  "better-auth": { name: "Better Auth", category: "auth" },
  ioredis: { name: "ioredis", category: "cache" },
  "@upstash/redis": { name: "Upstash Redis", category: "cache" },
  "@trpc/server": { name: "tRPC", category: "RPC/API" },
  trpc: { name: "tRPC", category: "RPC/API" },
}

type DeterministicRootDetection = {
  root: string
  submissions: SubmittedLibrary[]
  unknownDependencyTokens: string[]
  parseFailures: string[]
  hadManifest: boolean
}

function pathMatchesRoot(path: string, root: string): boolean {
  if (root === "./") return true
  return path.startsWith(`${root}/`) || path === root
}

function rootManifestPath(root: string, manifestName: string): string {
  if (root === "./") return manifestName
  return `${root}/${manifestName}`
}

function isCsprojPath(path: string): boolean {
  return path.toLowerCase().endsWith(".csproj")
}

function fileNameOf(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] ?? path
}

function mapDependencyTokenToLibrary(
  dependencyToken: string,
): { name: string; category: string } | null {
  const normalized = dependencyToken.trim().toLowerCase()
  if (!normalized) return null
  return DEPENDENCY_LIBRARY_MAP[normalized] ?? null
}

function inferExtractionMethod(lib: SubmittedLibrary): "deterministic" | "llm" {
  if (lib.extractionMethod) return lib.extractionMethod
  const evidence = lib.evidence?.toLowerCase() ?? ""
  if (evidence.includes("deterministic")) {
    return "deterministic"
  }
  if (evidence.includes("llm") || evidence.includes("fallback")) {
    return "llm"
  }
  if (
    evidence.includes("dependency") ||
    evidence.includes("gem ") ||
    evidence.includes("requirements.txt ") ||
    evidence.includes("go.mod ") ||
    evidence.includes("pom.xml ") ||
    evidence.includes("cargo.toml ") ||
    evidence.includes("composer.json ") ||
    evidence.includes(".csproj ") ||
    evidence.includes("mix.exs ") ||
    evidence.includes("package.swift ")
  ) {
    return "deterministic"
  }
  return "llm"
}

function parseJsonDependencies(content: string): {
  dependencyTokens: string[]
  parseFailed: boolean
} {
  try {
    const parsed = JSON.parse(content) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      require?: Record<string, string>
    }
    const tokens = new Set<string>()
    for (const bag of [
      parsed.dependencies,
      parsed.devDependencies,
      parsed.peerDependencies,
      parsed.optionalDependencies,
      parsed.require,
    ]) {
      for (const key of Object.keys(bag ?? {})) {
        tokens.add(key)
      }
    }
    return { dependencyTokens: Array.from(tokens), parseFailed: false }
  } catch {
    return { dependencyTokens: [], parseFailed: true }
  }
}

function parseGemfileDependencies(content: string): string[] {
  const out = new Set<string>()
  const gemRegex = /^\s*gem\s+["']([^"']+)["']/gm
  for (const match of content.matchAll(gemRegex)) {
    const name = match[1]?.trim()
    if (name) out.add(name)
  }
  return Array.from(out)
}

function parseRequirementsDependencies(content: string): string[] {
  const out = new Set<string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const token = line
      .replace(/\s*#.*$/, "")
      .split(/[<>=!~;\[\]\s]/)[0]
      ?.trim()
      .toLowerCase()
    if (token) out.add(token)
  }
  return Array.from(out)
}

function parsePyprojectDependencies(content: string): {
  dependencyTokens: string[]
  parseFailed: boolean
} {
  const malformedTableHeader = /^\s*\[[^\]\r\n]*$/m.test(content)
  if (malformedTableHeader) {
    return { dependencyTokens: [], parseFailed: true }
  }
  const out = new Set<string>()
  const projectDependenciesRegex = /\bdependencies\s*=\s*\[([\s\S]*?)\]/g
  for (const match of content.matchAll(projectDependenciesRegex)) {
    const section = match[1] ?? ""
    for (const entryMatch of section.matchAll(/["']([^"']+)["']/g)) {
      const raw = entryMatch[1]?.trim()
      if (!raw) continue
      const token = raw.split(/[<>=!~;\[\]\s]/)[0]?.trim().toLowerCase()
      if (token && /^[a-z0-9_.@/-]+$/.test(token)) {
        out.add(token)
      }
    }
  }

  const poetryDependenciesSectionRegex =
    /^\s*\[tool\.poetry\.dependencies\]\s*([\s\S]*?)(?=^\s*\[[^\]]+\]\s*$|\s*$)/gm
  for (const match of content.matchAll(poetryDependenciesSectionRegex)) {
    const section = match[1] ?? ""
    for (const line of section.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const dep = trimmed.split("=")[0]?.trim().toLowerCase()
      if (!dep || dep === "python") continue
      if (/^[a-z0-9_.@/-]+$/.test(dep)) {
        out.add(dep)
      }
    }
  }

  return { dependencyTokens: Array.from(out), parseFailed: false }
}

function parseGoModDependencies(content: string): string[] {
  const out = new Set<string>()
  const requireRegex = /^\s*([^\s]+)\s+v[0-9].*$/gm
  for (const match of content.matchAll(requireRegex)) {
    const mod = match[1]?.trim().toLowerCase()
    if (mod) out.add(mod)
  }
  return Array.from(out)
}

function parsePomDependencies(content: string): {
  dependencyTokens: string[]
  parseFailed: boolean
} {
  if (content.includes("<project") && !content.includes("</project>")) {
    return { dependencyTokens: [], parseFailed: true }
  }
  const out = new Set<string>()
  const groupIdRegex = /<groupId>\s*([^<\s]+)\s*<\/groupId>/g
  for (const match of content.matchAll(groupIdRegex)) {
    const groupId = match[1]?.trim().toLowerCase()
    if (groupId) out.add(groupId)
  }
  const artifactIdRegex = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g
  for (const match of content.matchAll(artifactIdRegex)) {
    const artifact = match[1]?.trim().toLowerCase()
    if (artifact) out.add(artifact)
  }
  return { dependencyTokens: Array.from(out), parseFailed: false }
}

function parseGradleDependencies(content: string): {
  dependencyTokens: string[]
  parseFailed: boolean
} {
  const withoutBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, "")
  const sanitized = withoutBlockComments.replace(/^\s*\/\/.*$/gm, "")
  const out = new Set<string>()
  const coordinateRegex = /["']([a-z0-9_.-]+):([a-z0-9_.-]+):[^"']+["']/gi
  for (const match of sanitized.matchAll(coordinateRegex)) {
    const group = match[1]?.trim().toLowerCase()
    const artifact = match[2]?.trim().toLowerCase()
    if (group) out.add(group)
    if (artifact) out.add(artifact)
  }

  const mapNotationRegex =
    /\b[a-zA-Z_][a-zA-Z0-9_]*\s*\(\s*group\s*=\s*["']([^"']+)["']\s*,\s*name\s*=\s*["']([^"']+)["'][^)]*\)/g
  for (const match of sanitized.matchAll(mapNotationRegex)) {
    const group = match[1]?.trim().toLowerCase()
    const artifact = match[2]?.trim().toLowerCase()
    if (group) out.add(group)
    if (artifact) out.add(artifact)
  }

  const mapNotationReversedRegex =
    /\b[a-zA-Z_][a-zA-Z0-9_]*\s*\(\s*name\s*=\s*["']([^"']+)["']\s*,\s*group\s*=\s*["']([^"']+)["'][^)]*\)/g
  for (const match of sanitized.matchAll(mapNotationReversedRegex)) {
    const artifact = match[1]?.trim().toLowerCase()
    const group = match[2]?.trim().toLowerCase()
    if (group) out.add(group)
    if (artifact) out.add(artifact)
  }

  const hasDependencyDeclaration =
    /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|kapt)\b/.test(
      sanitized,
    )
  const parseFailed = hasDependencyDeclaration && out.size === 0

  return { dependencyTokens: Array.from(out), parseFailed }
}

function parseCargoDependencies(content: string): string[] {
  const out = new Set<string>()
  let inDependenciesSection = false
  const sectionHeaderRegex = /^\s*\[([^\]]+)\]\s*$/
  const dependencyRegex = /^\s*([a-zA-Z0-9_-]+)\s*=\s*/
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const sectionMatch = line.match(sectionHeaderRegex)
    if (sectionMatch) {
      const sectionName = sectionMatch[1]?.trim().toLowerCase() ?? ""
      inDependenciesSection =
        sectionName === "dependencies" ||
        sectionName.endsWith(".dependencies") ||
        sectionName === "dev-dependencies" ||
        sectionName === "build-dependencies"
      continue
    }

    if (!inDependenciesSection) continue

    const dependencyMatch = line.match(dependencyRegex)
    const dep = dependencyMatch?.[1]?.trim().toLowerCase()
    if (dep) {
      out.add(dep)
    }
  }
  return Array.from(out)
}

function parseCsprojDependencies(content: string): {
  dependencyTokens: string[]
  parseFailed: boolean
} {
  if (content.includes("<Project") && !content.includes("</Project>")) {
    return { dependencyTokens: [], parseFailed: true }
  }
  const out = new Set<string>()
  const packageRefRegex = /<PackageReference\s+Include="([^"]+)"/g
  for (const match of content.matchAll(packageRefRegex)) {
    const dep = match[1]?.trim().toLowerCase()
    if (dep) out.add(dep)
  }
  const frameworkRefRegex = /<FrameworkReference\s+Include="([^"]+)"/g
  for (const match of content.matchAll(frameworkRefRegex)) {
    const dep = match[1]?.trim().toLowerCase()
    if (dep) out.add(dep)
  }
  return { dependencyTokens: Array.from(out), parseFailed: false }
}

function parseMixDependencies(content: string): string[] {
  const out = new Set<string>()
  const depRegex = /\{\s*:([a-zA-Z0-9_]+)\s*,/g
  for (const match of content.matchAll(depRegex)) {
    const dep = match[1]?.trim().toLowerCase()
    if (dep) out.add(dep)
  }
  return Array.from(out)
}

function parsePackageSwiftDependencies(content: string): string[] {
  const out = new Set<string>()
  const urlRegex = /url:\s*"[^"]*\/([^/"\s]+)"/g
  for (const match of content.matchAll(urlRegex)) {
    const dep = match[1]?.trim().toLowerCase()
    if (dep) out.add(dep)
  }
  const productRegex = /\.product\(\s*name:\s*"([^"]+)"/g
  for (const match of content.matchAll(productRegex)) {
    const dep = match[1]?.trim().toLowerCase()
    if (dep) out.add(dep)
  }
  return Array.from(out)
}

function parseDependenciesForManifest(
  path: string,
  content: string,
): { dependencyTokens: string[]; parseFailed: boolean } {
  const filename = fileNameOf(path)
  if (filename === "package.json" || filename === "composer.json") {
    return parseJsonDependencies(content)
  }
  if (filename === "Gemfile") {
    return { dependencyTokens: parseGemfileDependencies(content), parseFailed: false }
  }
  if (filename === "requirements.txt") {
    return {
      dependencyTokens: parseRequirementsDependencies(content),
      parseFailed: false,
    }
  }
  if (filename === "pyproject.toml") {
    return parsePyprojectDependencies(content)
  }
  if (filename === "go.mod") {
    return { dependencyTokens: parseGoModDependencies(content), parseFailed: false }
  }
  if (filename === "pom.xml") {
    return parsePomDependencies(content)
  }
  if (filename === "build.gradle" || filename === "build.gradle.kts") {
    return parseGradleDependencies(content)
  }
  if (filename === "Cargo.toml") {
    return { dependencyTokens: parseCargoDependencies(content), parseFailed: false }
  }
  if (filename === "mix.exs") {
    return { dependencyTokens: parseMixDependencies(content), parseFailed: false }
  }
  if (filename === "Package.swift") {
    return {
      dependencyTokens: parsePackageSwiftDependencies(content),
      parseFailed: false,
    }
  }
  if (isCsprojPath(path)) {
    return parseCsprojDependencies(content)
  }
  return { dependencyTokens: [], parseFailed: false }
}

function manifestPathsForRoot(allPaths: string[], root: string): string[] {
  const manifests = allPaths.filter((path) => {
    if (!pathMatchesRoot(path, root)) return false
    const fileName = fileNameOf(path)
    if (ROOT_MANIFEST_FILES.has(fileName)) {
      return path === rootManifestPath(root, fileName)
    }
    if (isCsprojPath(path)) {
      return root === "./" || path.startsWith(`${root}/`)
    }
    return false
  })
  return Array.from(new Set(manifests))
}

function deterministicDetectLibrariesForRoot(args: {
  root: string
  manifestContents: Record<string, string>
}): DeterministicRootDetection {
  const { root, manifestContents } = args
  const submissions: SubmittedLibrary[] = []
  const parseFailures: string[] = []
  const seenCanonical = new Set<string>()
  const unknownDependencyTokens = new Set<string>()
  const manifestPaths = Object.keys(manifestContents)

  for (const manifestPath of manifestPaths) {
    const content = manifestContents[manifestPath] ?? ""
    const { dependencyTokens, parseFailed } = parseDependenciesForManifest(
      manifestPath,
      content,
    )
    if (parseFailed) {
      parseFailures.push(manifestPath)
      continue
    }
    for (const token of dependencyTokens) {
      const match = mapDependencyTokenToLibrary(token)
      if (!match) {
        const normalizedToken = token.trim().toLowerCase()
        if (normalizedToken) {
          unknownDependencyTokens.add(normalizedToken)
        }
        continue
      }
      const canonical = normalizeLibraryName(match.name)
      const dedupeKey = `${root}:${canonical}`
      if (seenCanonical.has(dedupeKey)) continue
      seenCanonical.add(dedupeKey)
      submissions.push({
        name: canonical,
        path: root,
        category: match.category,
        evidence: `${manifestPath} dependency ${token}`,
        extractionMethod: "deterministic",
      })
    }
  }

  return {
    root,
    submissions,
    unknownDependencyTokens: Array.from(unknownDependencyTokens),
    parseFailures,
    hadManifest: manifestPaths.length > 0,
  }
}

const SYSTEM_PROMPT = `You are analyzing a repository to detect architectural libraries used by the codebase. Focus on ORM, HTTP client, auth, validation, cache, and similar — not every utility. Look across any language. Do not assume a single stack.

Config files to inspect (per language):
| Language / ecosystem | Config files |
| JS/TS (Node, Bun)    | package.json, pnpm-lock.yaml, yarn.lock |
| Python               | requirements.txt, pyproject.toml, Pipfile |
| Go                   | go.mod, go.sum |
| Java / Kotlin        | pom.xml, build.gradle, build.gradle.kts |
| Ruby                 | Gemfile |
| PHP                  | composer.json |
| C# / .NET            | *.csproj |
| Rust                 | Cargo.toml |
| Elixir               | mix.exs |
| Swift                | Package.swift |

Library categories and detection hints:
| Category   | Examples | Detection hints |
| ORM        | Prisma, Drizzle, TypeORM, Sequelize, Mongoose, SQLAlchemy, GORM | prisma, drizzle, typeorm, sequelize, mongoose, sqlalchemy, gorm |
| HTTP       | Express, Hono, Fastify, Next.js, FastAPI, Flask, Django, Axum | express, hono, fastify, next, fastapi, flask, django, axum |
| Auth       | Better Auth, NextAuth, Passport, Auth0, Clerk | better-auth, next-auth, passport, auth0, clerk |
| Validation | Zod, Yup, Joi, Pydantic | zod, yup, joi, pydantic |
| Cache      | ioredis, @upstash/redis, redis-py, go-redis | ioredis, upstash, redis |
| RPC/API    | tRPC, gRPC | trpc, grpc |

Search strategy:
1. list_files at each root for package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, pom.xml, Gemfile, composer.json, mix.exs
2. search for import patterns (from "prisma", import { drizzle }, require("express"), betterAuth, zod, ioredis)
3. get_file on package.json, requirements.txt, etc. to confirm dependencies
4. Focus on architectural deps — skip lodash, date-fns, uuid, etc. unless central to architecture

Cover only the listed roots. Call submit_libraries for each architectural library supported by manifests or imports; batch multiple libraries per call. Focus on architectural deps — skip utilities unless central. Prefer submitting once you have enough manifest/import evidence over exhaustive blind search.`

export async function identifyLibraries(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, orgId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()

  if (shouldSkipExtractorForPartialDeletesOnly(state)) {
    return {}
  }

  const scanPaths = partialScanPathsForExtractors(state)
  const scopeHint =
    state.ingestMode === "partial" && scanPaths.length > 0
      ? partialScanPromptSuffix(scanPaths)
      : ""

  const allRepoPaths = await listFilesRecursive(repositoryId, orgId)
  const scopedPaths =
    state.ingestMode === "partial" && scanPaths.length > 0
      ? filterPathsByPartialScan(allRepoPaths, scanPaths)
      : allRepoPaths

  const manifestPaths = roots.flatMap((root) => manifestPathsForRoot(scopedPaths, root))
  const manifestContents =
    manifestPaths.length > 0
      ? await fetchFiles(repositoryId, orgId, Array.from(new Set(manifestPaths)))
      : {}

  const deterministicSubmissions: SubmittedLibrary[] = []
  const rootsNeedingLlm: string[] = []
  const fallbackUnknownTokensByRoot = new Map<string, string[]>()
  const fallbackParseFailuresByRoot = new Map<string, string[]>()
  for (const root of roots) {
    const paths = manifestPathsForRoot(scopedPaths, root)
    const rootManifestContents: Record<string, string> = {}
    for (const path of paths) {
      rootManifestContents[path] = manifestContents[path] ?? ""
    }
    const deterministicResult = deterministicDetectLibrariesForRoot({
      root,
      manifestContents: rootManifestContents,
    })
    deterministicSubmissions.push(...deterministicResult.submissions)

    const hasDirectArchitecturalEvidence = deterministicResult.submissions.length > 0
    const hasUnknownDependencies = deterministicResult.unknownDependencyTokens.length > 0
    const hasParseFailure = deterministicResult.parseFailures.length > 0
    if (
      deterministicResult.hadManifest &&
      (!hasDirectArchitecturalEvidence || hasUnknownDependencies || hasParseFailure)
    ) {
      rootsNeedingLlm.push(root)
      fallbackUnknownTokensByRoot.set(
        root,
        deterministicResult.unknownDependencyTokens,
      )
      fallbackParseFailuresByRoot.set(root, deterministicResult.parseFailures)
    }
  }

  const capturedLibraries: { value: SubmittedLibrary[] } = { value: [] }
  if (rootsNeedingLlm.length > 0) {
    const fallbackRootContext = rootsNeedingLlm.map((root) => ({
      root,
      unknownDependencyTokens: fallbackUnknownTokensByRoot.get(root) ?? [],
      parseFailures: fallbackParseFailuresByRoot.get(root) ?? [],
    }))
    const tools = createIdentifyLibrariesTools(capturedLibraries)
    const agent = createAgent({
      model: getModel("medium", { temperature: 0.1 }),
      tools,
      contextMiddleware: {
        clearToolUsesTriggerTokens: 160_000,
        clearToolUsesKeepMessages: 16,
        summarizationTriggerTokens: 240_000,
        summarizationKeepMessages: 36,
      },
      systemPrompt: `${SYSTEM_PROMPT}

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${rootsNeedingLlm.join(", ")}.

Fallback context by root (unknown dependency tokens and parse failures):
${JSON.stringify(fallbackRootContext, null, 2)}

For roots with non-empty unknownDependencyTokens, treat deterministic results as already captured for known libraries. Focus fallback only on unresolved architectural dependencies represented by unknown tokens, and do not resubmit deterministic known libraries.

${REPO_EXPLORER_TOOLS_HINT}${scopeHint}`,
    })

    const userMessage = `For these ambiguous roots only: ${rootsNeedingLlm.join(", ")}. Resolve manifest uncertainty with concrete evidence. If fallback context lists unknownDependencyTokens for a root, analyze those tokens and only submit newly resolved architectural libraries. Do not re-submit deterministic known libraries. Call submit_libraries (batch per call) when evidence is clear; skip utilities and low-confidence guesses.`

    await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      mergeConfigs(getConfig(), {
        recursionLimit: 220,
      }),
    )

    if (capturedLibraries.value.length === 0) {
      getLogger().warn(
        "identifyLibraries: agent completed without submit_libraries for ambiguous roots (no libraries captured)",
        { repositoryId, targetHash, rootsNeedingLlm },
      )
    }
  }

  let submissions = [...deterministicSubmissions, ...capturedLibraries.value]
  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter((lib) => {
      const resolvedRoot = resolveSubmissionRoot(lib.path, roots)
      if (resolvedRoot === "./") return true
      if (resolvedRoot !== null) {
        return repoPathMatchesPartialScan(resolvedRoot, scanPaths)
      }
      return repoPathMatchesPartialScan(lib.path, scanPaths)
    })
  }

  const { objects: postObjects, claims: postClaims } = postProcessLibraries(
    submissions,
    { repositoryId, roots, targetHash },
  )

  return {
    extractedObjects: postObjects,
    extractedClaims: postClaims,
  }
}

/** Post-process captured libraries into objects and claims. Exported for testing. */
export function postProcessLibraries(
  capturedLibraries: SubmittedLibrary[],
  state: Pick<CodeIngestionState, "repositoryId" | "roots" | "targetHash">,
): { objects: ExtractedObject[]; claims: ExtractedClaim[] } {
  const { repositoryId, roots = ["./"], targetHash } = state
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const seenLibs = new Set<string>()

  for (const lib of capturedLibraries) {
    const root = resolveSubmissionRoot(lib.path, roots)
    if (root === null) continue
    const libraryName = normalizeLibraryName(lib.name)
    const dedupKey = `lib:${repositoryId}:${root}:${libraryName}`
    if (seenLibs.has(dedupKey)) continue
    seenLibs.add(dedupKey)

    const svcDeduplicationKey = `svc:${repositoryId}:${root}`
    const extractionMethod = inferExtractionMethod(lib)

    objects.push({
      kind: "Library",
      deduplicationKey: dedupKey,
      name: libraryName,
      summary: `${libraryName} used by ${root}${lib.category ? ` (${lib.category})` : ""}`,
      payload: lib.category ? { category: lib.category } : undefined,
    })

    claims.push({
      subjectRef: svcDeduplicationKey,
      subjectKind: "Service",
      objectRef: dedupKey,
      objectKind: "Library",
      predicate: "USES_LIBRARY",
      sourceId: `identifyLibraries:${repositoryId}:${root}:${libraryName}:${targetHash}`,
      sourceType: "git",
      extractionMethod,
      confidence: extractionMethod === "deterministic" ? 0.9 : 0.8,
      provenance: {
        root,
        libraryName,
        category: lib.category,
        evidence: lib.evidence,
      },
    })
  }

  return { objects, claims }
}
