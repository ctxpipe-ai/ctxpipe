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
  return rows.flatMap((row) =>
    row.provider === "github" && row.status === "ok" && row.connectionId
      ? githubSourceScopeRepositories(row.scope).map(({ name, ref }) => ({
          gitUrl: normalizeWorkspaceRepositoryUrl(`https://github.com/${name}`),
          ref,
          connectionId: row.connectionId as string,
          path: row.sourceKey.startsWith(SOURCES_FOLDER_PREFIX)
            ? row.sourceKey
            : SOURCES_FILE_PATH,
        }))
      : [],
  )
}
