import { createHash } from "node:crypto"
import { gitFileBytes } from "../../services/git/file-change.js"
import type { WorkspaceSliceWrite } from "./sync.js"

function gitBlobId(bytes: Buffer, objectFormat: "sha1" | "sha256"): string {
  return createHash(objectFormat)
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex")
}

/** Compare a slice with the current tree: keep changed files, delete stale ones. */
export function diffSlice(
  write: Pick<WorkspaceSliceWrite, "files" | "ownedPrefixes">,
  blobs: ReadonlyArray<{ path: string; sha: string }>,
): { files: WorkspaceSliceWrite["files"]; deletePaths: string[] } {
  const current = new Map(blobs.map((blob) => [blob.path, blob.sha]))
  const wanted = new Set(write.files.map((file) => file.path))
  const files = write.files.filter((file) => {
    const sha = current.get(file.path)
    if (!sha) return true
    return (
      gitBlobId(gitFileBytes(file), sha.length === 64 ? "sha256" : "sha1") !==
      sha
    )
  })
  const deletePaths = blobs
    .map((blob) => blob.path)
    .filter(
      (path) =>
        !wanted.has(path) &&
        write.ownedPrefixes.some((prefix) => path.startsWith(prefix)),
    )
  return { files, deletePaths }
}
