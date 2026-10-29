// The Service files of the roots. The roots file lists the files that the
// root steps of THIS run wrote. On a later ingest, classify-kind finds its
// file and changes nothing, so the list of a root is empty, also when the
// root has a Service file. Then this module finds the file in the context
// index, with the rules of classify-kind: the name of the package (or of the
// folder), a Service kind, and this source or no source.

import { posix } from "node:path"

import { nameKey } from "../../bin/knowledge-lib.mjs"
import { classifyRoot } from "../../classify-kind/scripts/kind-rules.mjs"
import {
  safePath,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"

/**
 * Give each root without a Service file in the roots file the Service files
 * of the index that describe its package. A root that already has one keeps
 * it. Returns `roots`, changed in place.
 */
export function addIndexedServices({
  roots,
  source,
  sourcePath,
  repository,
  index,
}) {
  if (roots.every((r) => r.files.some((f) => f.kind === "Service")))
    return roots
  const tracked = new Set(trackedFiles(source))
  for (const root of roots) {
    if (root.files.some((f) => f.kind === "Service")) continue
    const folder =
      root.path === "." ? repository.split("/")[1] : posix.basename(root.path)
    const keys = new Set(
      [classifyRoot(source, tracked, root.path).name, folder]
        .map(nameKey)
        .filter(Boolean),
    )
    const own = (entry) =>
      entry.owned === true ||
      (Array.isArray(entry.sources) &&
        entry.sources.some((s) => String(s).trim() === sourcePath))
    for (const entry of index)
      if (
        entry?.kind === "Service" &&
        typeof entry.path === "string" &&
        safePath(entry.path) &&
        keys.has(nameKey(entry.title)) &&
        (own(entry) || !entry.sources?.length) &&
        !root.files.some((f) => f.path === entry.path)
      )
        root.files.push({ path: entry.path, kind: "Service" })
  }
  return roots
}
