import { isScalar, isSeq } from "yaml"
import { updateKnowledgeMetadata } from "../workspaces/knowledge-metadata.js"
import {
  checkSourcePath,
  githubSourcePath,
  SOURCE_FILES_FOLDER,
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

function githubRepository(scope: Record<string, unknown>): string | null {
  return typeof scope.repository === "string"
    ? scope.repository.toLowerCase()
    : null
}

/** The repository (lowercase) that each GitHub file links, by path. */
function linkedRepositories(files: ReadonlyArray<RepoFile>) {
  const linked = new Map<string, string>()
  for (const file of files) {
    const parsed = parseSourceFile(file.path, file.content)
    if (!parsed.ok || parsed.source.provider !== "github") continue
    const repository = githubRepository(parsed.source.scope)
    if (repository) linked.set(file.path, repository)
  }
  return linked
}

function assertRepositoryFree(
  files: ReadonlyArray<RepoFile>,
  scope: Record<string, unknown>,
  except?: string,
) {
  const repository = githubRepository(scope)
  if (!repository) return
  for (const [path, linked] of linkedRepositories(files))
    if (linked === repository && path !== except)
      throw new SourceChangeError(
        409,
        `The repository is already a source in ${path}`,
      )
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

/** A new path for an add without a path. */
function newPath(
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
 * Change the `sources` list of a unit file: `from` becomes `to`. Returns the
 * new text, or null when the file does not name `from`. The rest of the file
 * stays as it is.
 */
function renameInUnit(content: string, from: string, to: string) {
  if (!content.includes(from)) return null
  let changed = false
  let text: string
  try {
    text = updateKnowledgeMetadata(content, (document) => {
      const list = document.get("sources", true)
      if (!isSeq(list)) return
      for (const item of list.items)
        if (isScalar(item) && item.value === from) {
          item.value = to
          changed = true
        }
    })
  } catch {
    // A unit with malformed front matter is not ours to change.
    return null
  }
  return changed ? text : null
}

/**
 * Apply one change to the source files. `files` are the files under
 * `sources/`. The result is the files to write and the paths to delete, for
 * one commit. A rename also moves `from` to `to` in the `sources` list of
 * each file in `unitFiles` (the Markdown files outside `sources/`).
 * Nothing here reads or writes git.
 */
export function applySourceFileChange(input: {
  files: ReadonlyArray<RepoFile>
  unitFiles?: ReadonlyArray<RepoFile>
  change: SourceChange
  /** Paths that an open pull request changes; a new file must not use one. */
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
  const byPath = new Map(files.map((file) => [file.path, file.content]))

  if (change.action === "add") {
    const taken = new Set([...byPath.keys(), ...reservedPaths])
    const path = change.path ?? newPath(change, taken)
    const provider = checkedPath(path)
    if (provider !== change.provider)
      throw new SourceChangeError(
        400,
        `The path is in the ${provider} folder, but the provider is ${change.provider}`,
      )
    if (byPath.has(path))
      throw new SourceChangeError(409, `A source exists at ${path}`)
    if (reservedPaths.has(path))
      throw new SourceChangeError(
        409,
        `An open pull request changes ${path}. Merge or close it first.`,
      )
    assertRepositoryFree(files, change.scope)
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
    assertRepositoryFree(files, change.scope, change.path)
    const content = renderChecked(
      {
        path: change.path,
        provider,
        connectionId: change.connectionId,
        scope: change.scope,
      },
      change.description === undefined
        ? parsed.body
        : bodyOf(change.description),
    )
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
  if (byPath.has(change.newPath) || reservedPaths.has(change.newPath))
    throw new SourceChangeError(409, `A source exists at ${change.newPath}`)
  const units = (input.unitFiles ?? []).flatMap((file) => {
    if (file.path.startsWith(`${SOURCE_FILES_FOLDER}/`)) return []
    const content = renameInUnit(file.content, change.path, change.newPath)
    return content === null ? [] : [{ path: file.path, content }]
  })
  return {
    writes: [{ path: change.newPath, content: current }, ...units],
    deletes: [change.path],
    path: change.newPath,
    provider,
  }
}
