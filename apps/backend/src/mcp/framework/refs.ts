import type {
  HandledRepository,
  RepositoryHandles,
} from "./repository-handles.js"
import { McpToolError } from "./tool-errors.js"

/**
 * A ref is short and relative to the `org` and `workspace` of the call
 * (ADR-051 §4): a knowledge unit path, or `<handle>:<path>` for a file of a
 * linked repository.
 */
export type ParsedRef =
  | { kind: "unit"; path: string }
  | { kind: "file"; handle: string; url: string; path: string }

/** A relative path with no `..`, no empty segment, no NUL; else `invalid_ref`. */
export function checkPath(path: string, ref: string): string {
  const segments = path.split("/")
  if (
    path.trim() === "" ||
    path.startsWith("/") ||
    path.includes("\0") ||
    segments.some((segment) => segment === ".." || segment === "")
  ) {
    throw new McpToolError(
      "invalid_ref",
      `"${ref}" is not a valid ref. Use a path from a result, for example knowledge/services/api.md or owner/name:src/index.ts.`,
    )
  }
  return path
}

/** {@link checkPath} for a path in a repository: no `.git` segment either. */
export function checkRepositoryPath(path: string, ref: string): string {
  checkPath(path, ref)
  if (path.split("/").some((segment) => segment.toLowerCase() === ".git")) {
    throw new McpToolError(
      "invalid_ref",
      `"${ref}" is not a valid ref. A repository path has no .git folder.`,
    )
  }
  return path
}

/**
 * The part before the first `:` names a repository only when `resolve`
 * finds it, so `owner/name`, `host/owner/name`, and another letter case all
 * work. A handle has no `:`. A prefix that names no linked repository makes
 * the whole ref a unit path. With `linked` (the handles that one Workspace
 * links), a prefix is a repository only when it is in that set (ADR-051 §4).
 */
export function parseRef(
  ref: string,
  handles: RepositoryHandles,
  linked?: ReadonlySet<string>,
): ParsedRef {
  const colon = ref.indexOf(":")
  if (colon > 0) {
    let repository: HandledRepository | null = null
    try {
      repository = handles.resolve(ref.slice(0, colon))
    } catch (error) {
      if (!(error instanceof McpToolError)) throw error
      if (error.code !== "repository_not_found") throw error
    }
    if (repository && (!linked || linked.has(repository.handle))) {
      return {
        kind: "file",
        handle: repository.handle,
        url: repository.url,
        path: checkRepositoryPath(ref.slice(colon + 1), ref),
      }
    }
  }
  return { kind: "unit", path: checkPath(ref, ref) }
}

export function formatRef(
  ref:
    | { kind: "unit"; path: string }
    | { kind: "file"; handle: string; path: string },
): string {
  return ref.kind === "unit" ? ref.path : `${ref.handle}:${ref.path}`
}
