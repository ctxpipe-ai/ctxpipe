import {
  listPackBlobs,
  nativeGit,
  packRootTree,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import { SOURCES_FILE_PATH } from "./sources-file.js"

async function blobAt(
  directory: string,
  commit: { sha: string; root?: string },
  path: string,
): Promise<string | null> {
  const tree = await packRootTree(directory, commit)
  if (!tree) return null
  const entry = (await nativeGit(directory, ["ls-tree", tree, "--", path]))
    .toString()
    .trim()
  return entry ? (entry.split(/\s+/)[2] ?? null) : null
}

/**
 * Read the Workspace head that a slice write goes on. `fresh` is true only
 * when the head has the same sources file as `rowsRevision`, the revision
 * whose projection planned the write. A stale write must not land: it could
 * restore the content of a source that the head removed.
 */
export async function readSliceTarget(input: {
  url: string
  token?: string
  headSha: string
  rowsRevision: string
  /** Workspace root folder; paths in the result are relative to it. */
  root?: string
}): Promise<{
  paths: string[]
  sourcesBlobSha: string | null
  fresh: boolean
}> {
  const additionalShas =
    input.rowsRevision === input.headSha ? [] : [input.rowsRevision]
  const pack = await readGitPackFromRemote({
    url: input.url,
    sha: input.headSha,
    additionalShas,
    token: input.token,
    root: input.root,
  })
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const sourcesBlobSha = await blobAt(directory, pack, SOURCES_FILE_PATH)
      return {
        paths: (await listPackBlobs(directory, pack)).map((blob) => blob.path),
        sourcesBlobSha,
        fresh:
          sourcesBlobSha ===
          (await blobAt(
            directory,
            { sha: input.rowsRevision, root: pack.root },
            SOURCES_FILE_PATH,
          )),
      }
    },
    pack,
  )
}
