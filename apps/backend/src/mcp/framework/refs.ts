import type { RepositoryHandles } from "./repository-handles.js"
import { McpToolError } from "./tool-errors.js"

/**
 * A ref is short and relative to the `org` and `workspace` of the call
 * (ADR-051 §4): a knowledge unit path, or `<handle>:<path>` for a file of a
 * linked repository.
 */
export type ParsedRef =
  | { kind: "unit"; path: string }
  | { kind: "file"; handle: string; url: string; path: string }

function checkPath(path: string, ref: string): string {
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

export function parseRef(ref: string, handles: RepositoryHandles): ParsedRef {
  const colon = ref.indexOf(":")
  if (colon > 0) {
    const prefix = ref.slice(0, colon)
    const repository = handles
      .list()
      .find((entry) => entry.handle.toLowerCase() === prefix.toLowerCase())
    if (repository) {
      return {
        kind: "file",
        handle: repository.handle,
        url: repository.url,
        path: checkPath(ref.slice(colon + 1), ref),
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
