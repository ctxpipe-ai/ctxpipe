import { parse as parseYaml } from "yaml"
import {
  fetchFiles,
  globFiles,
} from "../../../domain/codeIngestion/codesearchClient.js"

const OPENAPI_NAME_GLOBS = [
  "**/*openapi*.{json,yaml,yml}",
  "**/*swagger*.{json,yaml,yml}",
] as const

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
 * Matches any json/yaml/yml basename that contains "openapi" or "swagger".
 */
export async function discoverOpenApiSpecPaths(
  repositoryId: string,
  orgId: string,
  root: string,
): Promise<string[]> {
  const prefix = listPathForRoot(root)
  const seen = new Set<string>()
  for (const pattern of OPENAPI_NAME_GLOBS) {
    const globbed = await globFiles(repositoryId, orgId, {
      pattern,
      path: prefix,
      onlyFiles: true,
    })
    for (const entry of globbed.entries) {
      if (entry.type === "file") seen.add(entry.path)
    }
  }
  return [...seen].sort()
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
