import { parse as parseYaml } from "yaml"
import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"

const SPEC_BASENAMES = new Set([
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "swagger.json",
  "swagger.yaml",
  "swagger.yml",
])

function basename(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

function listPathForRoot(root: string): string {
  if (root === "./" || root === ".") return ""
  return root
}

/** Parent directory of a repo-relative file path (API surface path). */
export function apiDirectoryFromSpecPath(specPath: string): string {
  const slash = specPath.lastIndexOf("/")
  if (slash === -1) return "./"
  const parent = specPath.slice(0, slash)
  return parent === "" ? "./" : parent
}

export function parseOpenApiContent(
  raw: string,
  _specPath: string,
): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    if (trimmed.startsWith("{")) {
      const o = JSON.parse(trimmed) as unknown
      return isOpenApiLike(o) ? (o as Record<string, unknown>) : null
    }
    const parsed = parseYaml(raw) as unknown
    return isOpenApiLike(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function isOpenApiLike(o: unknown): o is Record<string, unknown> {
  if (typeof o !== "object" || o === null) return false
  const r = o as Record<string, unknown>
  if (typeof r.openapi === "string" && r.paths && typeof r.paths === "object")
    return true
  if (typeof r.swagger === "string" && r.paths && typeof r.paths === "object")
    return true
  return false
}

/**
 * Lists candidate OpenAPI/Swagger spec paths under a repository root.
 */
export async function discoverOpenApiSpecPaths(
  repositoryId: string,
  orgId: string,
  root: string,
): Promise<string[]> {
  const prefix = listPathForRoot(root)
  const allPaths = await listFilesRecursive(repositoryId, orgId, prefix)
  const out: string[] = []
  for (const p of allPaths) {
    if (SPEC_BASENAMES.has(basename(p))) out.push(p)
  }
  return out
}

export async function fetchAndParseOpenApiSpecs(
  repositoryId: string,
  orgId: string,
  specPaths: string[],
): Promise<Array<{ specPath: string; spec: Record<string, unknown> } | null>> {
  if (specPaths.length === 0) return []
  const contents = await fetchFiles(repositoryId, orgId, specPaths)
  return specPaths.map((specPath) => {
    const raw = contents[specPath]
    if (raw === undefined) return null
    const spec = parseOpenApiContent(raw, specPath)
    return spec ? { specPath, spec } : null
  })
}
