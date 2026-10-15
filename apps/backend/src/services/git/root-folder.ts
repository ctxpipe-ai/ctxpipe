import { repositoryFilePathSchema } from "./file-change.js"

/*
 * Path mapping between a repository and the Workspace root folder (CTX-709).
 * `rootPath` is normalized (see `workspaceRootPathSchema`); `""` is the
 * repository root.
 */

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
