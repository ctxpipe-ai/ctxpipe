import { isDeepStrictEqual } from "node:util"
import { updateKnowledgeMetadata } from "../workspaces/knowledge-metadata.js"
import { githubSourceScopeRepositories } from "./providers/github.js"
import {
  checkSourcePath,
  githubSourcePath,
  type SourceFile,
  sourcePathFor,
} from "./source-file.js"
import { parseSourceFile, renderSourceFile } from "./source-file-text.js"
import type { SourceProvider } from "./sources-file.js"

/**
 * One change of the files under `sources/` (ADR-050, revision 2026-10-16).
 * Each path is relative to the Workspace root folder. `description` is the
 * body of the file; an edit without it keeps the body.
 */
export type SourceChange =
  | {
      action: "add"
      /** Optional. The service names the file from the provider or the repository. */
      path?: string
      provider: SourceProvider
      connectionId: string
      scope: Record<string, unknown>
      description?: string
    }
  | {
      action: "edit"
      path: string
      provider: SourceProvider
      connectionId: string
      scope: Record<string, unknown>
      description?: string
    }
  | { action: "rename"; path: string; newPath: string }
  | { action: "remove"; path: string }

/** A change that the route answers with this HTTP status. */
export class SourceChangeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message)
  }
}

type RepoFile = { path: string; content: string }

/** Keys that the front matter owns. A scope must not set them. */
const FRONT_MATTER_KEYS = ["provider", "connection", "id", "kind"]

function checkedPath(path: string): SourceProvider {
  const checked = checkSourcePath(path)
  if (!checked.ok) throw new SourceChangeError(400, checked.reason)
  return checked.provider
}

/** Refuse a change whose path cannot name a source file (400), before any read. */
export function assertSourceChangeShape(change: SourceChange): void {
  if (change.action !== "add") checkedPath(change.path)
  else if (change.path !== undefined) checkedPath(change.path)
  if (change.action === "rename") checkedPath(change.newPath)
}

/**
 * One source of the Workspace: a projected `workspace_sources` row (its key
 * is the path of a source file, or the id of a legacy YAML entry), or a
 * source file.
 */
export type KnownSource = {
  path: string
  provider: string | null
  scope: unknown
}

/** The known sources: the projected rows, then each parsed file in `files`. */
function knownSources(
  files: ReadonlyArray<RepoFile>,
  sources: ReadonlyArray<KnownSource>,
): KnownSource[] {
  return [
    ...sources,
    ...files.flatMap((file) => {
      const parsed = parseSourceFile(file.path, file.content)
      return parsed.ok
        ? [
            {
              path: file.path,
              provider: parsed.source.provider,
              scope: parsed.source.scope,
            },
          ]
        : []
    }),
  ]
}

/** Refuse (409) a GitHub repository that another source already links. */
function assertRepositoryFree(
  known: ReadonlyArray<KnownSource>,
  scope: Record<string, unknown>,
  except?: string,
) {
  const wanted = new Set(
    githubSourceScopeRepositories(scope).map(({ name }) => name.toLowerCase()),
  )
  if (!wanted.size) return
  for (const source of known) {
    if (source.provider !== "github" || source.path === except) continue
    if (
      githubSourceScopeRepositories(source.scope).some(({ name }) =>
        wanted.has(name.toLowerCase()),
      )
    )
      throw new SourceChangeError(
        409,
        `The repository is already a source in ${source.path}`,
      )
  }
}

/** Render a source file and check that it parses (400 with the reason when not). */
function renderChecked(source: SourceFile, body: string): string {
  const reserved = FRONT_MATTER_KEYS.filter((key) => key in source.scope)
  if (reserved.length)
    throw new SourceChangeError(
      400,
      `The scope must not set ${reserved.join(", ")}`,
    )
  const content = renderSourceFile(source, body)
  const parsed = parseSourceFile(source.path, content)
  if (!parsed.ok) throw new SourceChangeError(400, parsed.detail)
  return content
}

function bodyOf(description: string | undefined): string {
  const text = description?.trim()
  return text ? `${text}\n` : ""
}

/** The path of a new file for an add without a path. */
export function sourceAddPath(
  change: Extract<SourceChange, { action: "add" }>,
  taken: ReadonlySet<string>,
): string {
  if (change.provider !== "github")
    return sourcePathFor(change.provider, "", taken)
  const [owner, name, ...rest] = String(change.scope.repository ?? "").split(
    "/",
  )
  if (!owner || !name || rest.length)
    throw new SourceChangeError(400, "repository: use owner/name")
  return githubSourcePath(owner, name)
}

/**
 * Change the front matter of `content` to `source` with the YAML Document API:
 * a key that keeps its value keeps its comments and its place.
 */
function editFrontMatter(content: string, source: SourceFile): string {
  const wanted: Record<string, unknown> = {
    connection: source.connectionId,
    ...source.scope,
  }
  return updateKnowledgeMetadata(content, (document) => {
    const current: Record<string, unknown> = document.toJSON() ?? {}
    for (const key of Object.keys(current))
      if (key !== "provider" && !(key in wanted)) document.delete(key)
    for (const [key, value] of Object.entries(wanted))
      if (!isDeepStrictEqual(current[key], value)) document.set(key, value)
  })
}

/**
 * Apply one change to the source files. `files` are the source files that
 * the change reads (with their text); `sources` are the other sources of the
 * Workspace (the projected rows), for the path and repository checks. The
 * result is the files to write and the paths to delete, for one commit. A
 * rename is one move of the file. Nothing here reads or writes git.
 */
export function applySourceFileChange(input: {
  files: ReadonlyArray<RepoFile>
  sources?: ReadonlyArray<KnownSource>
  change: SourceChange
  /** Paths that an open pull request changes; a new path must not use one. */
  reservedPaths?: ReadonlySet<string>
}): {
  writes: RepoFile[]
  deletes: string[]
  /** The path of the added, changed, or new file, or the path that goes away. */
  path: string
  /** The provider of the file, from its folder. */
  provider: SourceProvider
} {
  const { change, files } = input
  const reservedPaths = input.reservedPaths ?? new Set<string>()
  const known = knownSources(files, input.sources ?? [])
  const byPath = new Map(files.map((file) => [file.path, file.content]))
  const taken = new Set([
    ...known.map((source) => source.path),
    ...byPath.keys(),
  ])
  const assertFree = (path: string) => {
    if (taken.has(path))
      throw new SourceChangeError(409, `A source exists at ${path}`)
    if (reservedPaths.has(path))
      throw new SourceChangeError(
        409,
        `An open pull request changes ${path}. Merge or close it first.`,
      )
  }

  if (change.action === "add") {
    const path =
      change.path ??
      sourceAddPath(change, new Set([...taken, ...reservedPaths]))
    const provider = checkedPath(path)
    if (provider !== change.provider)
      throw new SourceChangeError(
        400,
        `The path is in the ${provider} folder, but the provider is ${change.provider}`,
      )
    assertFree(path)
    assertRepositoryFree(known, change.scope)
    const content = renderChecked(
      {
        path,
        provider,
        connectionId: change.connectionId,
        scope: change.scope,
      },
      bodyOf(change.description),
    )
    return { writes: [{ path, content }], deletes: [], path, provider }
  }

  const provider = checkedPath(change.path)
  const current = byPath.get(change.path)
  if (current === undefined)
    throw new SourceChangeError(404, `No source file at ${change.path}`)

  if (change.action === "remove")
    return { writes: [], deletes: [change.path], path: change.path, provider }

  if (change.action === "edit") {
    if (provider !== change.provider)
      throw new SourceChangeError(
        400,
        "The provider of a source cannot change. Add a new source instead.",
      )
    const parsed = parseSourceFile(change.path, current)
    if (!parsed.ok)
      throw new SourceChangeError(
        409,
        `The file cannot be read: ${parsed.detail}. Fix it in git first.`,
      )
    assertRepositoryFree(known, change.scope, change.path)
    const source = {
      path: change.path,
      provider,
      connectionId: change.connectionId,
      scope: change.scope,
    }
    // Check the scope as a full render, then keep the comments of the file.
    renderChecked(source, "")
    const edited = editFrontMatter(current, source)
    const content =
      change.description === undefined
        ? edited
        : edited.slice(0, edited.length - parsed.body.length) +
          bodyOf(change.description)
    const reparsed = parseSourceFile(change.path, content)
    if (!reparsed.ok) throw new SourceChangeError(400, reparsed.detail)
    return {
      writes: [{ path: change.path, content }],
      deletes: [],
      path: change.path,
      provider,
    }
  }

  const target = checkedPath(change.newPath)
  if (target !== provider)
    throw new SourceChangeError(
      400,
      "A rename keeps the provider folder. Add a new source for another provider.",
    )
  if (change.newPath === change.path)
    throw new SourceChangeError(400, "The new path is the old path")
  assertFree(change.newPath)
  return {
    writes: [{ path: change.newPath, content: current }],
    deletes: [change.path],
    path: change.newPath,
    provider,
  }
}
