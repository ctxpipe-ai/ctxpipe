import { createHash } from "node:crypto"
import { nativeGit } from "../../services/git/pack.js"
import type { SourceFileBlob } from "./projection-plan.js"
import { SOURCE_FILES_FOLDER } from "./source-file.js"
import { SOURCES_FILE_PATH } from "./sources-file.js"

/** The folder of the source files, as a path prefix. */
export const SOURCES_FOLDER_PREFIX = `${SOURCE_FILES_FOLDER}/`

/**
 * The read options of `listMarkdownFilesAtGitSha` that also give the
 * sources of a Workspace: `.ctxpipe/sources.yaml` (until CTX-721 T11) and
 * every blob under `sources/`, also one that is not Markdown, so that a bad
 * file gets an invalid row.
 */
export const SOURCES_TREE_READ = {
  extraPaths: [SOURCES_FILE_PATH],
  extraFolders: [SOURCES_FOLDER_PREFIX],
} as const

/**
 * Split one tree read (with {@link SOURCES_TREE_READ}) into the Markdown
 * files, the text of `.ctxpipe/sources.yaml`, and the blobs under
 * `sources/`. The Markdown files keep the source files.
 */
export function splitSourcesTree<T extends { path: string; content: string }>(
  treeFiles: readonly T[],
): { files: T[]; sourcesFile: string | null; sourceFiles: SourceFileBlob[] } {
  return {
    files: treeFiles.filter((file) => file.path.endsWith(".md")),
    sourcesFile:
      treeFiles.find((file) => file.path === SOURCES_FILE_PATH)?.content ??
      null,
    sourceFiles: treeFiles
      .filter((file) => file.path.startsWith(SOURCES_FOLDER_PREFIX))
      .map((file) => ({ path: file.path, text: file.content })),
  }
}

/**
 * The fence id of the sources at commit `sha`: a slice or mirror write lands
 * only when the head has the same fence id as the revision whose projection
 * planned it. It is the blob id of `.ctxpipe/sources.yaml` when only that
 * file exists, the tree id of `sources/` when only that folder exists, and a
 * hash of both when both exist (until CTX-721 T11). Null when neither
 * exists. Each form is a 40-character hex id, as the old blob id was.
 */
export async function sourcesFenceAt(
  directory: string,
  sha: string,
): Promise<string | null> {
  const listing = (
    await nativeGit(directory, [
      "ls-tree",
      sha,
      "--",
      SOURCES_FILE_PATH,
      SOURCE_FILES_FOLDER,
    ])
  ).toString()
  const ids = new Map(
    listing
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta = "", path = ""] = line.split("\t")
        return [path, meta.split(/\s+/)[2] ?? ""] as const
      }),
  )
  const yaml = ids.get(SOURCES_FILE_PATH) ?? null
  const folder = ids.get(SOURCE_FILES_FOLDER) ?? null
  if (yaml && folder)
    return createHash("sha1").update(`${yaml} ${folder}`).digest("hex")
  return yaml ?? folder
}
