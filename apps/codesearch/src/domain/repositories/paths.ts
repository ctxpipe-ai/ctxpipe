import { lstat, realpath, stat } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { REPO_CACHE_DIR } from "../../config/paths.js"

/** Matches backend `DEFAULT_CHECKOUT_KEY` for the primary branch checkout. */
export const DEFAULT_CHECKOUT_KEY = "default"

/** Git working tree for a given ref checkout. */
export function repoCheckoutPath(
  orgId: string,
  repoId: string,
  checkoutKey: string = DEFAULT_CHECKOUT_KEY,
): string {
  return `${REPO_CACHE_DIR}/${orgId}/${repoId}/checkouts/${checkoutKey}`
}

/** Kùzu DB file beside the checkout directory (sibling `.kuzu` file). */
export function kuzuDbPath(
  orgId: string,
  repoId: string,
  checkoutKey: string = DEFAULT_CHECKOUT_KEY,
): string {
  return `${REPO_CACHE_DIR}/${orgId}/${repoId}/checkouts/${checkoutKey}.kuzu`
}

export function resolveSafePath(basePath: string, relativePath: string): string {
  const base = resolve(basePath)
  const fullPath = resolve(basePath, relativePath)
  if (fullPath !== base && !fullPath.startsWith(`${base}${sep}`)) {
    throw new Error("Path traversal is not allowed")
  }
  return fullPath
}

function assertWithinBase(base: string, resolvedPath: string): void {
  if (resolvedPath !== base && !resolvedPath.startsWith(`${base}${sep}`)) {
    throw new Error("Path traversal is not allowed")
  }
}

/** Resolves a repo-relative path and follows symlinks to a readable regular file. */
export async function resolveSafeReadableFilePath(
  basePath: string,
  relativePath: string,
): Promise<string> {
  const candidate = resolveSafePath(basePath, relativePath)
  const linkStat = await lstat(candidate)
  if (linkStat.isDirectory()) {
    throw new Error("Not a file")
  }
  const [base, resolved] = await Promise.all([
    realpath(basePath),
    realpath(candidate),
  ])
  assertWithinBase(base, resolved)
  const fileStat = await stat(resolved)
  if (!fileStat.isFile()) {
    throw new Error("Not a file")
  }
  return resolved
}
