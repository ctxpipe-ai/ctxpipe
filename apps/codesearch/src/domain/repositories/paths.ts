import { randomUUID } from "node:crypto"
import { constants, type Dirent } from "node:fs"
import {
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { REPO_CACHE_DIR } from "../../config/paths.js"

/** Matches backend `DEFAULT_CHECKOUT_KEY` for the primary branch checkout. */
export const DEFAULT_CHECKOUT_KEY = "default"

export { workspaceCheckoutKey } from "../../../../../shared/workspace-checkout.js"

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

/** True when a repo-relative path has a `.git` segment, in any letter case. */
export function hasGitSegment(path: string): boolean {
  return path.toLowerCase().split(/[\\/]/).includes(".git")
}

function notFound(): Error {
  return Object.assign(new Error("Path not found"), { code: "ENOENT" })
}

/**
 * Resolves a repo-relative path inside the checkout. A path with a `.git`
 * segment fails with ENOENT, the same as a missing path, because codesearch
 * never reads or searches inside `.git`.
 */
export function resolveSafePath(
  basePath: string,
  relativePath: string,
): string {
  const base = resolve(basePath)
  const fullPath = resolve(basePath, relativePath)
  if (fullPath !== base && !fullPath.startsWith(`${base}${sep}`)) {
    throw new Error("Path traversal is not allowed")
  }
  if (hasGitSegment(relative(base, fullPath))) throw notFound()
  return fullPath
}

/**
 * Resolves a repo-relative path to its real path. Symlinks are followed only
 * when the final target stays inside the checkout. A path or a target with a
 * `.git` segment is refused, because `.git/config` can hold a clone token. A
 * refused path fails with ENOENT, the same as a missing path. Read from the
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
    throw notFound()
  }
  if (hasGitSegment(relative(base, resolved))) throw notFound()
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

/**
 * Reads a regular file inside the checkout. A symlink is followed only when
 * its final target stays inside the checkout and outside `.git`. The read
 * refuses a path or a target with a `.git` segment, the same as a missing
 * path, because `.git/config` can hold a clone token. The file is opened
 * without following a symlink at its last component. On Linux, the real path
 * of the open descriptor is checked again, so a path that a checkout changes
 * after the first check is not read. Other platforms have only the first
 * check.
 */
export async function readContainedFile(
  basePath: string,
  relativePath: string,
) {
  const resolved = await resolveSafeReadableFilePath(basePath, relativePath)
  const base = await realpath(basePath)
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (process.platform === "linux") {
      const opened = await readlink(`/proc/self/fd/${handle.fd}`)
      if (
        !opened.startsWith(`${base}${sep}`) ||
        hasGitSegment(relative(base, opened))
      ) {
        throw notFound()
      }
    }
    if (!(await handle.stat()).isFile()) {
      throw new Error("Not a file")
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/**
 * Lists a directory inside the checkout. `realBase` is the real path of the
 * checkout root, and `dirPath` is a real path below it that a caller resolved
 * before. The directory is opened without following a symlink at its last
 * component. On Linux, the real path of the open descriptor is checked again,
 * and the list is read through the descriptor, so a path that a checkout
 * changes after the first check is not listed. Other platforms have only the
 * first check. The list never holds a `.git` entry, in any letter case.
 */
export async function readContainedDirectory(
  realBase: string,
  dirPath: string,
): Promise<Dirent<string>[]> {
  const handle = await open(
    dirPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    let listPath = dirPath
    if (process.platform === "linux") {
      listPath = `/proc/self/fd/${handle.fd}`
      const opened = await readlink(listPath)
      if (
        (opened !== realBase && !opened.startsWith(`${realBase}${sep}`)) ||
        hasGitSegment(relative(realBase, opened))
      ) {
        throw notFound()
      }
    }
    const entries = await readdir(listPath, { withFileTypes: true })
    return entries.filter((entry) => !hasGitSegment(entry.name))
  } finally {
    await handle.close()
  }
}

/**
 * Writes a file in a checkout directory without following a symlink at
 * `path`: writes a new file beside it, then renames the new file over the
 * old entry. The parent directory must be a real directory of the checkout.
 */
export async function replaceCheckoutFile(
  path: string,
  content: string,
): Promise<void> {
  const temporaryPath = join(dirname(path), `.ctxpipe-${randomUUID()}.tmp`)
  await writeFile(temporaryPath, content, { flag: "wx" })
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}
