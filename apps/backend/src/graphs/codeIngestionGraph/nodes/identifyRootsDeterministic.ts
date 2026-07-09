import {
  fetchFiles,
  listFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import type { CodeIngestionState } from "../schemas.js"
import { expandWorkspaceGlobs, packageRootsFromPaths } from "./identifyRootsGlobExpand.js"
import {
  parseCargoWorkspaceMembers,
  parseDenoWorkspace,
  parseGoWorkUsePaths,
  parseGradleSettingsIncludes,
  parseLernaPackages,
  parseMavenPomModules,
  parsePackageJsonWorkspaces,
  parsePnpmWorkspacePackages,
  parseRushProjectFolders,
  parseUvWorkspaceMembers,
} from "./identifyRootsParsers.js"
import { WORKSPACE_PACKAGE_MARKER_FILES } from "./workspacePackageMarkers.js"

export type DeterministicRootsDetection =
  | {
      decision: "confident"
      roots: string[]
      evidence: string[]
    }
  | {
      decision: "ambiguous"
      roots: string[]
      partialRoots: string[]
      reason: string
      evidence: string[]
    }

type FileContents = Record<string, string>

const ROOT_MANIFESTS = [
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
  "package.json",
  "lerna.json",
  "rush.json",
  "deno.json",
  "deno.jsonc",
  "Cargo.toml",
  "go.work",
  "pyproject.toml",
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "workspace.json",
  "nx.json",
] as const

function normalizeRoot(root: string): string {
  let normalized = root.trim()
  if (normalized.startsWith("./")) normalized = normalized.slice(2)
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1)
  if (!normalized || normalized === ".") return "./"
  return normalized
}

function addMany(target: Set<string>, values: string[]): void {
  for (const value of values) {
    const normalized = normalizeRoot(value)
    if (normalized === "./") continue
    target.add(normalized)
  }
}

function normalizeOutputRoots(roots: Set<string>): string[] {
  const normalized = Array.from(roots).map((root) => normalizeRoot(root))
  const uniq = Array.from(new Set(normalized))
  if (uniq.length === 0) return ["./"]
  const withoutRoot = uniq.filter((root) => root !== "./")
  return (withoutRoot.length > 0 ? withoutRoot : ["./"]).sort()
}

function hasRootPackageMarker(rootEntries: Awaited<ReturnType<typeof listFiles>>): boolean {
  return rootEntries.some(
    (entry) =>
      entry.type === "file" && WORKSPACE_PACKAGE_MARKER_FILES.has(entry.name),
  )
}

function parseWorkspaceJsonProjects(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as {
      projects?: Record<string, string | { root?: string }>
    }
    if (!parsed.projects) return []
    const roots: string[] = []
    for (const value of Object.values(parsed.projects)) {
      if (typeof value === "string") {
        roots.push(value)
      } else if (value && typeof value.root === "string") {
        roots.push(value.root)
      }
    }
    return roots.map((root) => normalizeRoot(root)).filter((root) => root !== "./")
  } catch {
    return []
  }
}

function shouldIgnoreCandidateRoot(path: string): boolean {
  return (
    path === "./" ||
    path.startsWith("node_modules/") ||
    path.includes("/node_modules/") ||
    path.startsWith(".git/")
  )
}

async function fetchRootManifestContents(
  state: CodeIngestionState,
  manifests: string[],
): Promise<FileContents> {
  if (manifests.length === 0) return {}
  return fetchFiles(state.repositoryId, state.orgId, manifests)
}

export async function deterministicDetectRoots(
  state: CodeIngestionState,
): Promise<DeterministicRootsDetection> {
  const rootEntries = await listFiles(state.repositoryId, state.orgId, "")
  const rootFiles = new Set(
    rootEntries.filter((entry) => entry.type === "file").map((entry) => entry.path),
  )
  const presentManifests = ROOT_MANIFESTS.filter((manifest) =>
    rootFiles.has(manifest),
  )
  const contents = await fetchRootManifestContents(state, presentManifests)

  const roots = new Set<string>()
  const workspacePatterns: string[] = []
  const evidence: string[] = []
  const ambiguityReasons: string[] = []

  const pnpmManifestPath = rootFiles.has("pnpm-workspace.yaml")
    ? "pnpm-workspace.yaml"
    : rootFiles.has("pnpm-workspace.yml")
      ? "pnpm-workspace.yml"
      : null
  if (pnpmManifestPath) {
    const packages = parsePnpmWorkspacePackages(contents[pnpmManifestPath] ?? "")
    if (packages.length > 0) {
      workspacePatterns.push(...packages)
      evidence.push(`${pnpmManifestPath}:packages`)
    } else {
      ambiguityReasons.push(`${pnpmManifestPath} present but no packages parsed`)
    }
  }

  if (rootFiles.has("package.json")) {
    const workspaces = parsePackageJsonWorkspaces(contents["package.json"] ?? "")
    if (workspaces.length > 0) {
      workspacePatterns.push(...workspaces)
      evidence.push("package.json:workspaces")
    }
  }

  if (rootFiles.has("lerna.json")) {
    const packages = parseLernaPackages(contents["lerna.json"] ?? "")
    if (packages.length > 0) {
      workspacePatterns.push(...packages)
      evidence.push("lerna.json:packages")
    } else {
      ambiguityReasons.push("lerna.json present but no packages parsed")
    }
  }

  if (rootFiles.has("rush.json")) {
    const projectFolders = parseRushProjectFolders(contents["rush.json"] ?? "")
    if (projectFolders.length > 0) {
      addMany(roots, projectFolders)
      evidence.push("rush.json:projects")
    } else {
      ambiguityReasons.push("rush.json present but no projects parsed")
    }
  }

  const denoManifestPath = rootFiles.has("deno.json")
    ? "deno.json"
    : rootFiles.has("deno.jsonc")
      ? "deno.jsonc"
      : null
  if (denoManifestPath) {
    const workspaceMembers = parseDenoWorkspace(contents[denoManifestPath] ?? "")
    if (workspaceMembers.length > 0) {
      addMany(roots, workspaceMembers)
      evidence.push(`${denoManifestPath}:workspace`)
    } else {
      ambiguityReasons.push(`${denoManifestPath} present but no workspace parsed`)
    }
  }

  if (rootFiles.has("Cargo.toml")) {
    const members = parseCargoWorkspaceMembers(contents["Cargo.toml"] ?? "")
    if (members.length > 0) {
      workspacePatterns.push(...members)
      evidence.push("Cargo.toml:[workspace].members")
    }
  }

  if (rootFiles.has("go.work")) {
    const usePaths = parseGoWorkUsePaths(contents["go.work"] ?? "")
    if (usePaths.length > 0) {
      addMany(roots, usePaths)
      evidence.push("go.work:use")
    } else {
      ambiguityReasons.push("go.work present but no use directives parsed")
    }
  }

  if (rootFiles.has("pyproject.toml")) {
    const uvMembers = parseUvWorkspaceMembers(contents["pyproject.toml"] ?? "")
    if (uvMembers.length > 0) {
      workspacePatterns.push(...uvMembers)
      evidence.push("pyproject.toml:[tool.uv.workspace].members")
    }
  }

  if (rootFiles.has("pom.xml")) {
    const modules = parseMavenPomModules(contents["pom.xml"] ?? "")
    if (modules.length > 0) {
      addMany(roots, modules)
      evidence.push("pom.xml:modules")
    }
  }

  const gradleSettingsPath = rootFiles.has("settings.gradle")
    ? "settings.gradle"
    : rootFiles.has("settings.gradle.kts")
      ? "settings.gradle.kts"
      : null
  if (gradleSettingsPath) {
    const includes = parseGradleSettingsIncludes(contents[gradleSettingsPath] ?? "")
    if (includes.length > 0) {
      addMany(roots, includes)
      evidence.push(`${gradleSettingsPath}:include`)
    }
  }

  if (rootFiles.has("workspace.json")) {
    const workspaceProjects = parseWorkspaceJsonProjects(
      contents["workspace.json"] ?? "",
    )
    if (workspaceProjects.length > 0) {
      addMany(roots, workspaceProjects)
      evidence.push("workspace.json:projects")
    } else {
      ambiguityReasons.push("workspace.json present but no projects parsed")
    }
  }

  if (rootFiles.has("nx.json") && !rootFiles.has("workspace.json")) {
    ambiguityReasons.push(
      "nx.json present without workspace.json projects; deterministic detection needs fallback",
    )
  }

  if (workspacePatterns.length > 0) {
    const allPaths = await listFilesRecursive(state.repositoryId, state.orgId)
    const candidateRoots = packageRootsFromPaths(
      allPaths,
      WORKSPACE_PACKAGE_MARKER_FILES,
    ).filter((candidate) => !shouldIgnoreCandidateRoot(candidate))
    const expanded = expandWorkspaceGlobs({
      patterns: workspacePatterns,
      candidateRoots,
    })
    addMany(roots, expanded.roots)
    if (expanded.roots.length > 0) {
      evidence.push("workspace globs resolved from package markers")
    }
    if (expanded.unresolvedPatterns.length > 0) {
      ambiguityReasons.push(
        `unresolved workspace patterns: ${expanded.unresolvedPatterns.join(", ")}`,
      )
    }
  }

  const resolvedRoots = normalizeOutputRoots(roots)
  if (resolvedRoots.length === 1 && resolvedRoots[0] === "./") {
    const hasMonorepoSignals =
      evidence.length > 0 ||
      rootFiles.has("nx.json") ||
      rootFiles.has("workspace.json") ||
      rootFiles.has("pnpm-workspace.yaml") ||
      rootFiles.has("pnpm-workspace.yml") ||
      rootFiles.has("go.work") ||
      rootFiles.has("rush.json") ||
      rootFiles.has("lerna.json")

    if (!hasMonorepoSignals) {
      if (hasRootPackageMarker(rootEntries) || presentManifests.length === 0) {
        return {
          decision: "confident",
          roots: ["./"],
          evidence: ["fallback:repo-root"],
        }
      }
    }
  }

  if (ambiguityReasons.length > 0) {
    return {
      decision: "ambiguous",
      roots: resolvedRoots,
      partialRoots: resolvedRoots.filter((root) => root !== "./"),
      reason: ambiguityReasons.join("; "),
      evidence,
    }
  }

  return {
    decision: "confident",
    roots: resolvedRoots,
    evidence,
  }
}
