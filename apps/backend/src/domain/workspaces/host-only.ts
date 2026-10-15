import { isDeepStrictEqual } from "node:util"
import { parseYamlObject, splitFrontMatter } from "../ingestion/front-matter.js"
import type { HOST_FIELDS } from "../ingestion/patch-validator.js"

/**
 * The Workspace paths that only the host writes (CTX-722). A source grants
 * data flow, so no agent write can change its config. The patch validator,
 * the ingest ref broker and conversation publish all read this list.
 * CTX-721 adds `sources/` here.
 */
const HOST_ONLY_FOLDERS = [".ctxpipe"] as const

/**
 * True when `path` is a host-only folder or a file in one. The match ignores
 * case, so a checkout on a case-insensitive file system cannot write the
 * folder under another spelling.
 */
export function isHostOnlyPath(path: string): boolean {
  const folded = path.normalize("NFC").toLowerCase()
  return HOST_ONLY_FOLDERS.some(
    (folder) => folded === folder || folded.startsWith(`${folder}/`),
  )
}

/**
 * The host fields that give a file to ingestion (ADR-052 section 3): a file
 * with `generated_by: ctxpipe-extract` and a source in `sources` is the
 * source's file, which ingestion can rewrite or delete. The other host fields
 * do not change who owns a file.
 */
type OwnershipField = Extract<
  (typeof HOST_FIELDS)[number],
  "generated_by" | "sources"
>

/**
 * The ownership field that an agent write adds or changes, or null. Only the
 * host sets these fields. An agent can remove them, or remove an entry from
 * `sources`, because that gives the file to people. `before` is null for a
 * new file.
 */
export function addedOwnershipField(
  before: string | null,
  after: string,
): OwnershipField | null {
  const front = splitFrontMatter(after)
  const next = front ? parseYamlObject(front.yaml) : null
  if (!next) return null
  const baseFront = before === null ? null : splitFrontMatter(before)
  const base = (baseFront ? parseYamlObject(baseFront.yaml) : null) ?? {}
  if (
    "generated_by" in next &&
    !isDeepStrictEqual(next.generated_by, base.generated_by)
  )
    return "generated_by"
  if (!("sources" in next)) return null
  const kept = Array.isArray(base.sources) ? base.sources : []
  return Array.isArray(next.sources) &&
    next.sources.every((source) =>
      kept.some((old) => isDeepStrictEqual(old, source)),
    )
    ? null
    : "sources"
}
