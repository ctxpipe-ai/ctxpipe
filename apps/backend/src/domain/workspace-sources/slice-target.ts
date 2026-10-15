import {
  listTreeBlobs,
  nativeGit,
  packRootTree,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import { sourcesHaveNone } from "./projection-plan.js"
import { SOURCE_FILE_MAX_BYTES } from "./source-file.js"
import { SOURCES_FOLDER_PREFIX, sourcesFenceAt } from "./source-tree.js"
import { SOURCES_FILE_PATH } from "./sources-file.js"

/** The sources of the head: the YAML text and the blobs under `sources/`. */
async function readHeadSources(
  directory: string,
  pack: { sha: string; root?: string },
) {
  const tree = await packRootTree(directory, pack)
  const blobs = tree
    ? await listTreeBlobs(directory, tree, [
        SOURCES_FILE_PATH,
        SOURCES_FOLDER_PREFIX,
      ])
    : []
  const read = async (sha: string) =>
    (await nativeGit(directory, ["cat-file", "blob", sha])).toString()
  const yaml = blobs.find((blob) => blob.path === SOURCES_FILE_PATH)
  return {
    text: yaml ? await read(yaml.sha) : null,
    sourceFiles: await Promise.all(
      blobs
        .filter((blob) => blob.path.startsWith(SOURCES_FOLDER_PREFIX))
        .map(async (blob) => {
          const text = await read(blob.sha)
          return Buffer.byteLength(text) > SOURCE_FILE_MAX_BYTES
            ? { path: blob.path, text: "", omitted: "too_large" as const }
            : { path: blob.path, text }
        }),
    ),
  }
}

/**
 * Read the Workspace head that a slice write goes on. `fresh` is true only
 * when the head has the same sources (`.ctxpipe/sources.yaml` and the
 * `sources/` tree, see {@link sourcesFenceAt}) as `rowsRevision`, the revision
 * whose projection planned the write. A stale write must not land: it could
 * restore the content of a source that the head removed.
 *
 * A cleanup passes its `removed` targets. Its `fresh` is true while the head
 * sources have none of them: a later edit of a source does not drop the
 * cleanup, because no later projection plans it again.
 */
export async function readSliceTarget(input: {
  url: string
  token?: string
  headSha: string
  rowsRevision: string
  /** Workspace root folder; paths in the result are relative to it. */
  root?: string
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
    root: input.root,
  })
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const sourcesBlobSha = await sourcesFenceAt(directory, pack)
      const { removed } = input
      return {
        paths: (await listPackBlobs(directory, pack)).map((blob) => blob.path),
        sourcesBlobSha,
        fresh: removed
          ? await sourcesHaveNone(
              await readHeadSources(directory, pack),
              removed,
            )
          : sourcesBlobSha ===
            (await sourcesFenceAt(directory, {
              sha: input.rowsRevision,
              root: pack.root,
            })),
      }
    },
    pack,
  )
}
