import { connectorMirrorRoot } from "../codeIngestion/connectorMirrorPaths.js"
import { normalizeValidityBound } from "./hydrate-phases.js"

/**
 * The source's own time of a Workspace file, as an ISO time, or null
 * (CTX-1516). It is the `valid_from` of the document, and of each claim of
 * the file with no time of its own. A file with no source time takes the
 * time of the commit that introduced it. The time comes from the file
 * alone, so all branches can share it (ADR-071 decision 2):
 *
 * - a connector mirror file: its `createdAt` (GitHub issues and pull
 *   requests, Linear, Plain, PagerDuty, Buildkite), or the `thread_ts` of a
 *   Slack thread;
 * - a design record (kind `Decision`, or an `ADR-<n>` file name): its
 *   front matter `date`, else its `**Date:**` (or `Date:`) line. The
 *   `decisions` ingest skill writes this line from the date of the KEP, the
 *   RFC, the PEP or the ADR.
 *
 * A Notion or Confluence mirror file gives no creation time.
 */
export function sourceTime(file: {
  path: string
  kind: string | null | undefined
  attributes: Record<string, unknown>
  body: string
}): string | null {
  const { attributes } = file
  const root = connectorMirrorRoot(file.path)
  if (root === "slack") {
    const seconds = Number(attributes.thread_ts)
    return Number.isFinite(seconds) && seconds > 0
      ? new Date(seconds * 1000).toISOString()
      : null
  }
  if (root !== null) return timeOf(attributes.createdAt)
  const name = file.path.slice(file.path.lastIndexOf("/") + 1)
  if (file.kind?.toLowerCase() !== "decision" && !/^adr-\d/i.test(name))
    return null
  return (
    timeOf(attributes.date) ??
    timeOf(
      /(?:\*\*Date:\*\*|^Date:)[ \t]*(\d{4}-\d{2}-\d{2})/m.exec(file.body)?.[1],
    )
  )
}

/** A YAML time (a string or a date) as an ISO time, or null. */
function timeOf(value: unknown): string | null {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  return typeof value === "string" ? normalizeValidityBound(value) : null
}
