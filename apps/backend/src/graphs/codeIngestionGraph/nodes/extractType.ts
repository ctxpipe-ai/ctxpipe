import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"

const CONFIG_FILES = new Set([
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
])

function findConfigInRoot(files: string[], root: string): string | null {
  const prefix = root === "./" ? "" : `${root}/`
  for (const f of files) {
    const name = f.split("/").pop()
    if (name && CONFIG_FILES.has(name) && f.startsWith(prefix)) {
      const rel = root === "./" ? f : f.slice(prefix.length)
      if (!rel.includes("/") || rel === name) return f
    }
  }
  return null
}

function classifyFromPackageJson(content: string): "Service" | "Library" {
  try {
    const pkg = JSON.parse(content) as { scripts?: Record<string, string> }
    const scripts = pkg.scripts ?? {}
    const startScripts = ["start", "dev", "serve"]
    if (startScripts.some((s) => scripts[s])) return "Service"
  } catch {
    // ignore parse errors
  }
  return "Library"
}

function classifyFromCargoToml(content: string): "Service" | "Library" {
  if (content.includes("[[bin]]")) return "Service"
  return "Library"
}

function classifyRoot(
  content: string,
  filename: string,
): "Service" | "Library" {
  if (filename.endsWith("package.json")) return classifyFromPackageJson(content)
  if (filename.endsWith("Cargo.toml")) return classifyFromCargoToml(content)
  return "Library"
}

function rootToName(root: string): string {
  if (root === "./") return "root"
  return root.split("/").pop() ?? root
}

export async function extractType(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, orgId, roots = ["./"] } = state
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []

  const allPaths = await listFilesRecursive(repositoryId, orgId)
  const contents =
    allPaths.length > 0
      ? await fetchFiles(repositoryId, orgId, allPaths)
      : {}

  for (const root of roots) {
    const configPath = findConfigInRoot(allPaths, root)
    if (!configPath) continue

    const content = contents[configPath] ?? ""
    const type = classifyRoot(content, configPath)
    const name = rootToName(root)
    const deduplicationKey = `svc:${repositoryId}:${root}`

    objects.push({
      type,
      deduplicationKey,
      name,
      summary: `${type} at ${root}`,
    })

    claims.push({
      subjectRef: deduplicationKey,
      predicate: "IMPLEMENTED_IN",
      objectRef: repositoryId,
      sourceId: `extractType:${repositoryId}:${root}:${state.targetHash}`,
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence: 0.9,
      provenance: { root, configPath },
    })
  }

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}

