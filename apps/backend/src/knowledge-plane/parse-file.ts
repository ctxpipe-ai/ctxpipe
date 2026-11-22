import { extractUrls } from "../domain/codeIngestion/referenceResolver.js"
import {
  type HydrateUnit,
  hydrateKnowledgeTree,
} from "../domain/workspaces/hydrate.js"
import {
  isLinkedRepositoryDeclaration,
  parseSimpleFrontMatter,
} from "../domain/workspaces/layout.js"
import {
  WORKSPACE_LINK_SCHEME,
  workspaceBlobTarget,
} from "../domain/workspaces/mirror-units.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
import { workspaceRelativePath } from "../services/git/root-folder.js"
import { type FileReferences, fileReferences } from "./reference-keys.js"

/** The parse of one Workspace file for the knowledge plane. */
type ParsedFile =
  /** A knowledge file. */
  | { kind: "unit"; unit: HydrateUnit; references: FileReferences }
  /** A knowledge file that does not parse: a `failed` document (ADR-067 decision 8). */
  | { kind: "failed"; error: string }
  /** Not a knowledge file. */
  | { kind: "none" }

/**
 * True when the path can hold a knowledge file: the path rules of
 * `hydrateKnowledgeTree` (Markdown, not agent instructions, not a linked
 * repository declaration).
 */
export function isKnowledgePath(path: string): boolean {
  return (
    path.endsWith(".md") &&
    !isLinkedRepositoryDeclaration(path) &&
    path !== "AGENTS.md" &&
    !path.startsWith(".agents/")
  )
}

/**
 * Parse one Workspace file alone, with the hydrate parse. The result depends
 * only on the text of the file (ADR-066 decision 5), so the writer parses
 * only the files of the Git diff:
 * - A `FROM_SOURCE` claim names each source path of the `sources` front
 *   matter, whether the source file exists or not.
 * - A blob URL of the Workspace repository links to its path, whether the
 *   file exists or not.
 * - A mirror reference link (a Linear identifier, a provider URL) and a
 *   `CHANGED` claim of a merged pull request name a reference key, and the
 *   file states its own keys (`fileReferences`). The read finds the
 *   documents of a key.
 *
 * The claims keep the `valid_from` of the file. The mapper (`knowledgeRows`)
 * gives a claim with no time the time of the tree row: the source time of
 * the file, else the time of the introducing commit.
 */
export function parseKnowledgeFile(input: {
  workspaceId: string
  /** The Workspace path of a blob URL (`workspaceBlobPath`). */
  blobPath: (url: string) => string | null
  /** The path from the Workspace root. */
  path: string
  content: string
  /** Path of each GitHub source file → its repository URL. */
  sourceRepositories: ReadonlyMap<string, string>
}): ParsedFile {
  const parsed = hydrateKnowledgeTree({
    workspaceId: input.workspaceId,
    files: [{ path: input.path, content: input.content }],
    claimAllSources: true,
  })
  const [skip] = parsed.skipped
  if (skip) return { kind: "failed", error: skip.reason }
  const [unit] = parsed.units
  if (!unit) return { kind: "none" }
  for (const url of extractUrls(unit.body)) {
    const target = input.blobPath(url)
    const link = `${WORKSPACE_LINK_SCHEME}${target}`
    if (target && target !== unit.path && !unit.links.includes(link))
      unit.links.push(link)
  }
  return {
    kind: "unit",
    unit,
    references: fileReferences({
      path: unit.path,
      kind: unit.kind ?? null,
      body: unit.body,
      links: unit.links,
      attributes: parseSimpleFrontMatter(input.content).attributes,
      sourceRepositories: input.sourceRepositories,
    }),
  }
}

/**
 * The Workspace path that a blob URL of the Workspace repository names,
 * whether the file exists or not, or null. The URL gives a path from the
 * repository root, so a path outside the Workspace root names no Workspace
 * file.
 */
export function workspaceBlobPath(
  workspaceUrl: string,
  root: string,
): (url: string) => string | null {
  const repository = normalizeWorkspaceRepositoryUrl(workspaceUrl)
  return (url) => {
    try {
      const path = workspaceBlobTarget(url, repository)
      return path === null ? null : workspaceRelativePath(root, path)
    } catch {
      // A malformed escape in the URL: it names no path.
      return null
    }
  }
}
