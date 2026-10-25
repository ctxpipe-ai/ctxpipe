import { isDeepStrictEqual } from "node:util"

import { parseYamlObject, splitFrontMatter } from "../ingestion/front-matter.js"
import type { HOST_FIELDS } from "../ingestion/patch-validator.js"

/**
 * The Workspace paths that no agent write can change without a pull request
 * (CTX-722, CTX-721). A source grants data flow, so a person must review a
 * change to its config: `.ctxpipe/` holds the old sources config, and each
 * file under `sources/` is one source. The patch validator, the ingest ref
 * broker and the semantic merge write without a pull request, so they refuse
 * these paths. Conversation publish pushes only to the session branch, so it
 * allows them. Each agent write path must call this one function. The
 * Workspace format file `.ctxpipe/workspace.yaml` is in `.ctxpipe/`, so only
 * bootstrap and an upgrade pull request change its format. The Always update
 * action of an owner or admin changes only its `upgrades` setting.
 */
const HOST_ONLY_FOLDERS = [".ctxpipe", "sources"] as const

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
 * The refusal message for the first host-only path in `paths`, or null. A
 * file job commits to the default branch without a pull request, so it must
 * not touch these paths.
 */
export function hostOnlyRefusal(paths: readonly string[]): string | null {
  const hostOnly = paths.find(isHostOnlyPath)
  return hostOnly
    ? `${hostOnly} is host-only. Change it through a pull request.`
    : null
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
