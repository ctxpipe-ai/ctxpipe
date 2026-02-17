import { resolve, sep } from "node:path"
import { REPO_CACHE_DIR } from "../../config/paths.js"

export function repoCachePath(orgId: string, repoId: string): string {
  return `${REPO_CACHE_DIR}/${orgId}/${repoId}`
}

export function resolveSafePath(basePath: string, relativePath: string): string {
  const base = resolve(basePath)
  const fullPath = resolve(basePath, relativePath)
  if (fullPath !== base && !fullPath.startsWith(`${base}${sep}`)) {
    throw new Error("Path traversal is not allowed")
  }
  return fullPath
}
