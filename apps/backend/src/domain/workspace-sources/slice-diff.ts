import type { WorkspaceSliceWrite } from "./sync.js"

/**
 * Write every slice file and delete the stale files under the owned paths.
 * Files under `keepPrefixes` stay. The connector mirror write skips files
 * whose content did not change.
 */
export function diffSlice(
  write: Pick<
    WorkspaceSliceWrite,
    "files" | "ownedPrefixes" | "keepPrefixes" | "deletePaths"
  >,
  paths: readonly string[],
): { files: WorkspaceSliceWrite["files"]; deletePaths: string[] } {
  const wanted = new Set(write.files.map((file) => file.path))
  const under = (path: string, prefixes: readonly string[]) =>
    prefixes.some((prefix) => path.startsWith(prefix))
  if (write.deletePaths) {
    const present = new Set(paths)
    return {
      files: write.files,
      deletePaths: write.deletePaths.filter((path) => present.has(path)),
    }
  }
  return {
    files: write.files,
    deletePaths: paths.filter(
      (path) =>
        !wanted.has(path) &&
        under(path, write.ownedPrefixes) &&
        !under(path, write.keepPrefixes),
    ),
  }
}
