import { githubPins } from "../../models/workspace-source-state.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import {
  type PreviousSourceRow,
  resolveSourceRows,
  type SourceFileBlob,
} from "./projection-plan.js"
import { githubSourceScopeRepositories } from "./providers/github.js"
import { checkSourcePath } from "./source-file.js"
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
 * The source file path of each repository that a GitHub source file under
 * `sources/` declares, by normalized repository URL (ADR-050 revision
 * 2026-10-16). It reads only the files, as the projection does once the
 * folder exists; an entry of `.ctxpipe/sources.yaml` has no source path.
 * Ingestion v2 writes this path into `sources` (ADR-052 section 3).
 */
export function githubSourcePathsByRepository(
  sourceFiles: ReadonlyArray<SourceFileBlob>,
): Map<string, string> {
  return new Map(
    githubSourceRepositories(null, null, sourceFiles).flatMap((declared) =>
      declared.path.startsWith(SOURCES_FOLDER_PREFIX)
        ? [[declared.gitUrl, declared.path] as const]
        : [],
    ),
  )
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

/**
 * The source file path of the GitHub source row that pins `gitUrl`, or null
 * when no row with a source path does (for example a row of the YAML dual
 * read). The pull request mirror stamps it into each file.
 */
export function githubSourcePathOf(
  rows: ReadonlyArray<{
    id: string
    provider: string | null
    state: unknown
    sourceKey: string
  }>,
  gitUrl: string,
): string | null {
  const target = normalizeWorkspaceRepositoryUrl(gitUrl)
  const row = rows.find(
    (candidate) =>
      checkSourcePath(candidate.sourceKey).ok &&
      githubPins(candidate).some(
        (pin) => normalizeWorkspaceRepositoryUrl(pin.gitUrl) === target,
      ),
  )
  return row?.sourceKey ?? null
}
