import {
  listTreeBlobs,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import { sourcesFenceAt } from "./source-tree.js"

/**
 * Read the Workspace head that a slice write goes on. `fresh` is true only
 * when the head has the same sources (`.ctxpipe/sources.yaml` and the
 * `sources/` tree, see {@link sourcesFenceAt}) as `rowsRevision`, the revision
 * whose projection planned the write. A stale write must not land: it could
 * restore the content of a source that the head removed.
 */
export async function readSliceTarget(input: {
  url: string
  token?: string
  headSha: string
  rowsRevision: string
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
  })
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const sourcesBlobSha = await sourcesFenceAt(directory, pack.sha)
      return {
        paths: (await listTreeBlobs(directory, pack.sha)).map(
          (blob) => blob.path,
        ),
        sourcesBlobSha,
        fresh:
          sourcesBlobSha ===
          (await sourcesFenceAt(directory, input.rowsRevision)),
      }
    },
    pack,
  )
}
