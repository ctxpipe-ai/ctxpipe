import {
  listTreeBlobs,
  nativeGit,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import { sourcesFileHasNone } from "./projection-plan.js"
import { SOURCES_FILE_PATH } from "./sources-file.js"

async function blobAt(
  directory: string,
  sha: string,
  path: string,
): Promise<string | null> {
  const entry = (await nativeGit(directory, ["ls-tree", sha, "--", path]))
    .toString()
    .trim()
  return entry ? (entry.split(/\s+/)[2] ?? null) : null
}

/**
 * Read the Workspace head that a slice write goes on. `fresh` is true only
 * when the head has the same sources file as `rowsRevision`, the revision
 * whose projection planned the write. A stale write must not land: it could
 * restore the content of a source that the head removed.
 *
 * A cleanup passes its `removed` targets. Its `fresh` is true while the head
 * sources file has none of them: a later edit of the file does not drop the
 * cleanup, because no later projection plans it again.
 */
export async function readSliceTarget(input: {
  url: string
  token?: string
  headSha: string
  rowsRevision: string
  removed?: ReadonlyArray<{
    provider: string
    connectionId: string
    scope: Record<string, unknown>
  }>
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
      const sourcesBlobSha = await blobAt(
        directory,
        pack.sha,
        SOURCES_FILE_PATH,
      )
      const { removed } = input
      return {
        paths: (await listTreeBlobs(directory, pack.sha)).map(
          (blob) => blob.path,
        ),
        sourcesBlobSha,
        fresh: removed
          ? await sourcesFileHasNone(
              sourcesBlobSha
                ? (
                    await nativeGit(directory, [
                      "cat-file",
                      "blob",
                      sourcesBlobSha,
                    ])
                  ).toString()
                : null,
              removed,
            )
          : sourcesBlobSha ===
            (await blobAt(directory, input.rowsRevision, SOURCES_FILE_PATH)),
      }
    },
    pack,
  )
}
