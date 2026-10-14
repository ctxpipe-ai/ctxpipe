import { posix } from "node:path"
import { z } from "zod"
import { repositoryFilePathSchema } from "../../services/git/file-change.js"
import { nativeGit } from "../../services/git/pack.js"

/**
 * The root folder of a Workspace in its context repository (CTX-709). ctx|
 * reads and writes only below this folder. `""` is the repository root.
 * The stored value is normalized: relative, no trailing slash.
 */
export const workspaceRootPathSchema = z
  .string()
  .max(200)
  .transform((raw) => raw.trim().replace(/\/+$/, ""))
  .refine(
    (path) =>
      path === "" ||
      (path.split("/").length <= 16 &&
        path
          .split("/")
          .every(
            (segment) =>
              /^[A-Za-z0-9._-]+$/.test(segment) &&
              segment !== "." &&
              segment !== ".." &&
              segment.toLowerCase() !== ".git",
          )),
    "Use a relative folder path such as docs/context, with letters, digits, '.', '_', '-' and '/'",
  )

/**
 * The one place that reads the root folder of a Workspace. Today the value
 * comes from the Workspace row or a revision; a file in the repository can
 * feed it later.
 */
export function workspaceRootPath(
  source: { rootPath?: string | null } | null | undefined,
): string {
  return workspaceRootPathSchema.parse(source?.rootPath ?? "")
}

/** True when `path` (repository-relative) is a file path below `rootPath`. */
export function isInsideWorkspaceRoot(rootPath: string, path: string): boolean {
  if (!repositoryFilePathSchema.safeParse(path).success) return false
  return rootPath === "" || path.startsWith(`${rootPath}/`)
}

export function pathsOutsideWorkspaceRoot(
  rootPath: string,
  paths: Iterable<string>,
): string[] {
  return [...paths].filter((path) => !isInsideWorkspaceRoot(rootPath, path))
}

/** Maps a root-relative path to its repository path. Throws on an unsafe path. */
export function workspaceRepositoryPath(
  rootPath: string,
  relativePath: string,
): string {
  const path = repositoryFilePathSchema.parse(relativePath)
  return rootPath === "" ? path : `${rootPath}/${path}`
}

/** Maps a repository path to its root-relative path; null when it is outside. */
export function workspaceRelativePath(
  rootPath: string,
  path: string,
): string | null {
  if (!isInsideWorkspaceRoot(rootPath, path)) return null
  return rootPath === "" ? path : path.slice(rootPath.length + 1)
}

export type WorkspaceRootViolation = {
  path: string
  reason: "outside_root" | "symlink_outside_root"
}

/**
 * Finds the changes from `base` to `head` that leave the root folder: a path
 * outside it, or a new symlink below it whose target is outside it. Git
 * records a write through an existing symlink at the target path, so the
 * path check also catches that case.
 */
export async function gitChangesOutsideWorkspaceRoot(input: {
  directory: string
  base: string
  head: string
  rootPath: string
}): Promise<WorkspaceRootViolation[]> {
  const raw = (
    await nativeGit(input.directory, [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      input.base,
      input.head,
    ])
  ).toString("utf8")
  const fields = raw.split("\0")
  const violations: WorkspaceRootViolation[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const path = fields[i + 1] ?? ""
    // ":<old mode> <new mode> <old sha> <new sha> <status>"
    const [, newMode = "", , newSha = ""] = (fields[i] ?? "")
      .slice(1)
      .split(" ")
    if (!isInsideWorkspaceRoot(input.rootPath, path)) {
      violations.push({ path, reason: "outside_root" })
      continue
    }
    if (newMode !== "120000") continue
    const target = (
      await nativeGit(input.directory, ["cat-file", "blob", newSha])
    ).toString("utf8")
    if (!symlinkStaysInRoot(input.rootPath, path, target))
      violations.push({ path, reason: "symlink_outside_root" })
  }
  return violations
}

function symlinkStaysInRoot(
  rootPath: string,
  path: string,
  target: string,
): boolean {
  if (target.startsWith("/") || target.includes("\\") || target.includes("\0"))
    return false
  const resolved = posix.normalize(posix.join(posix.dirname(path), target))
  if (resolved === (rootPath || ".")) return true
  return isInsideWorkspaceRoot(rootPath, resolved)
}
