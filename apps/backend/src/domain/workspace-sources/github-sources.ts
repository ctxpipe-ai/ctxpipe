import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import {
  type PreviousSourceRow,
  resolveSourceRows,
  type SourceFileBlob,
} from "./projection-plan.js"
import { githubSourceScopeRepositories } from "./providers/github.js"
import { SOURCES_FOLDER_PREFIX } from "./source-tree.js"
import { SOURCES_FILE_PATH } from "./sources-file.js"

export type DeclaredGithubRepository = {
  gitUrl: string
  ref: string | null
  connectionId: string
  /** The file that declares it: `.ctxpipe/sources.yaml` or a source file. */
  path: string
}

/**
 * The linked repositories that the GitHub sources of a Workspace declare,
 * each with its ref and the connection that reads it. It reads the rows of
 * {@link resolveSourceRows}, so it has the winners of the projection: each
 * `ok` GitHub row in row order (the entries of `.ctxpipe/sources.yaml` until
 * CTX-721 T11, then the source files in byte order). When `connectionIds`
 * (the org's GitHub connections) is set, a source with another connection
 * links nothing. An invalid file or entry declares nothing; the projection
 * shows its error. A YAML entry can still name the Workspace repository;
 * the caller skips it.
 */
export function githubSourceRepositories(
  text: string | null,
  connectionIds: ReadonlySet<string> | null,
  sourceFiles: ReadonlyArray<SourceFileBlob> = [],
  options: {
    /** The rows of the previous projected revision: they decide the winners. */
    previousRows?: ReadonlyArray<PreviousSourceRow>
    workspaceUrl?: string | null
  } = {},
): DeclaredGithubRepository[] {
  const rows = resolveSourceRows({
    text,
    files: sourceFiles,
    connections:
      connectionIds === null
        ? null
        : new Map([...connectionIds].map((id) => [id, { id, type: "github" }])),
    previousRows: options.previousRows,
    workspaceUrl: options.workspaceUrl,
  })
  const linked = new Set<string>()
  return linkingOrder(rows).flatMap((row) => {
    const connectionId = row.connectionId
    if (row.provider !== "github" || row.status !== "ok" || !connectionId)
      return []
    return githubSourceScopeRepositories(row.scope).flatMap(({ name, ref }) => {
      const gitUrl = normalizeWorkspaceRepositoryUrl(
        `https://github.com/${name}`,
      )
      if (linked.has(gitUrl)) return []
      linked.add(gitUrl)
      return [
        {
          gitUrl,
          ref,
          connectionId,
          path: row.sourceKey.startsWith(SOURCES_FOLDER_PREFIX)
            ? row.sourceKey
            : SOURCES_FILE_PATH,
        },
      ]
    })
  })
}

/**
 * The rows in the order that links their repositories: the source files
 * first, then the YAML entries in file order. A source file that can link
 * holds its repository alone (the projection makes a second one invalid),
 * and a YAML entry skips a repository that a file or an earlier entry links.
 */
export function linkingOrder<T extends { sourceKey: string }>(
  rows: readonly T[],
): T[] {
  const isFile = (row: T) => row.sourceKey.startsWith(SOURCES_FOLDER_PREFIX)
  return [...rows.filter(isFile), ...rows.filter((row) => !isFile(row))]
}
