import { realpath, stat } from "node:fs/promises"
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

/** Merged SCIP index beside the checkout directory (sibling `.scip` file). */
export function scipIndexPath(
  orgId: string,
  repoId: string,
  checkoutKey: string = DEFAULT_CHECKOUT_KEY,
): string {
  return `${REPO_CACHE_DIR}/${orgId}/${repoId}/checkouts/${checkoutKey}.scip`
}

/** Language-specific SCIP shard beside the checkout directory. */
export function scipLangShardPath(
  orgId: string,
  repoId: string,
  langId: string,
  checkoutKey: string = DEFAULT_CHECKOUT_KEY,
): string {
  return `${REPO_CACHE_DIR}/${orgId}/${repoId}/checkouts/${checkoutKey}.${langId}.scip`
}

export function resolveSafePath(
  basePath: string,
  relativePath: string,
): string {
  const base = resolve(basePath)
  const fullPath = resolve(basePath, relativePath)
  if (fullPath !== base && !fullPath.startsWith(`${base}${sep}`)) {
    throw new Error("Path traversal is not allowed")
  }
  return fullPath
}

/**
 * Resolves a repo-relative path to its real path. Symlinks are followed only
 * when the final target stays inside the checkout. A target outside the
 * checkout fails with ENOENT, the same as a missing path. Read from the
 * returned path, not from the original one.
 */
export async function resolveContainedRealPath(
  basePath: string,
  relativePath: string,
): Promise<string> {
  const candidate = resolveSafePath(basePath, relativePath)
  const [base, resolved] = await Promise.all([
    realpath(basePath),
    realpath(candidate),
  ])
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw Object.assign(new Error("Path not found"), { code: "ENOENT" })
  }
  return resolved
}

/** Resolves a repo-relative path to the real path of a regular file inside the checkout. */
export async function resolveSafeReadableFilePath(
  basePath: string,
  relativePath: string,
): Promise<string> {
  const resolved = await resolveContainedRealPath(basePath, relativePath)
  if (!(await stat(resolved)).isFile()) {
    throw new Error("Not a file")
  }
  return resolved
}
