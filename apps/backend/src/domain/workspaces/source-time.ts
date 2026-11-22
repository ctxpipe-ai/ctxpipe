import { z } from "zod"

import { asStringArray } from "../codeIngestion/connectorFrontmatter.js"
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
 *   requests, Linear) or `created_at` (Plain, PagerDuty, Buildkite), or the
 *   `thread_ts` of a Slack thread;
 * - a design record (front matter kind `Decision`, or an `ADR-<n>` file
 *   name): its front matter `date`, else its `**Date:**` (or `Date:`) line.
 *   The `decisions` ingest skill writes this line from the date of the KEP,
 *   the RFC, the PEP or the ADR.
 *
 * A Notion or Confluence mirror file gives no creation time.
 */
export function sourceTime(file: {
  path: string
  /** The front matter of the file. */
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
  if (root !== null)
    return timeOf(attributes.createdAt) ?? timeOf(attributes.created_at)
  const name = file.path.slice(file.path.lastIndexOf("/") + 1)
  const kind = typeof attributes.kind === "string" ? attributes.kind : ""
  if (kind.trim().toLowerCase() !== "decision" && !/^adr-\d/i.test(name))
    return null
  return (
    timeOf(attributes.date) ??
    timeOf(
      /(?:\*\*Date:\*\*|^Date:)[ \t]*(\d{4}-\d{2}-\d{2})/m.exec(file.body)?.[1],
    )
  )
}

/**
 * The pull requests that closed an issue mirror file, with the time of the
 * close, or null. Both stacks link the issue to each of them from that time
 * (CTX-1516).
 *
 * - A GitHub issue: its `closedBy`, from its `closedAt`.
 * - A Linear issue: the merged GitHub pull requests of its
 *   `githubReferences`, from its `completedAt`, else its `canceledAt`
 *   (CTX-1526). GitHub also gives `closedAt` for an issue that closed as not
 *   planned.
 */
export function closingPullRequests(
  attributes: Record<string, unknown>,
): { urls: string[]; closedAt: string } | null {
  const closedAt = timeOf(attributes.closedAt)
  if (closedAt) return { urls: asStringArray(attributes.closedBy), closedAt }
  if (attributes.source !== "linear" || attributes.type !== "issue") return null
  const endedAt =
    timeOf(attributes.completedAt) ?? timeOf(attributes.canceledAt)
  if (!endedAt) return null
  const mergedPull = z.object({
    kind: z.literal("pull_request"),
    state: z.literal("merged"),
    url: z.string(),
  })
  const references: unknown[] = Array.isArray(attributes.githubReferences)
    ? attributes.githubReferences
    : []
  const urls = references.flatMap((reference) => {
    const parsed = mergedPull.safeParse(reference)
    return parsed.success ? [parsed.data.url] : []
  })
  return { urls, closedAt: endedAt }
}

/**
 * A front matter time as an ISO time, or null. The YAML core schema of the
 * front matter parse gives a time as a string.
 */
function timeOf(value: unknown): string | null {
  return typeof value === "string" ? normalizeValidityBound(value) : null
}
