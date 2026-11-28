import { z } from "zod"

import { asStringArray } from "../codeIngestion/connectorFrontmatter.js"
import { connectorMirrorRoot } from "../codeIngestion/connectorMirrorPaths.js"
import { normalizeValidityBound } from "./hydrate-phases.js"

/**
 * The times of a document (CTX-1710), as ISO times by default. Null when
 * unknown.
 *
 * - `createdAt`: when the item began in its source.
 * - `updatedAt`: when the content last changed in its source.
 * - `expiresAt`: a hint from the author that the content is stale after
 *   this time. It is not a verdict: an expired document is still found.
 */
export type DocumentTimes<T = string> = {
  createdAt: T | null
  updatedAt: T | null
  expiresAt: T | null
}

/**
 * The times that a Workspace file states itself (CTX-1710), from its front
 * matter and, for a design record, its body. The time comes from the file
 * alone, so all branches can share it (ADR-071 decision 2). A file keeps
 * the property names of its source. The read compares the keys with no case
 * and no `_`, so `updated_at`, `updatedAt` and `UpdatedAt` are one key. Thus
 * an old file and a file that an outside agent edits give their times, and
 * ctxpipe rewrites no file.
 *
 * `createdAt`:
 * - a connector mirror file: its `createdAt` (GitHub, Linear, Plain,
 *   PagerDuty, Buildkite) or `createdTime` (Notion), or the `threadTs` of a
 *   Slack thread;
 * - a design record (front matter kind `Decision`, or an `ADR-<n>` file
 *   name): its front matter `date`, else its `**Date:**` (or `Date:`) line.
 *   The `decisions` ingest skill writes this line from the date of the KEP,
 *   the RFC, the PEP or the ADR.
 *
 * `updatedAt`, of a connector mirror file only: its `updatedAt` (GitHub,
 * Linear, Plain, PagerDuty), `lastEditedTime` (Notion) or `finishedAt`
 * (Buildkite), or the `latest` ts of a Slack thread (its last reply). The
 * source of an authored file is the Workspace Git, so the last commit gives
 * its time (`withGitTimes`).
 *
 * `expiresAt`: the `expiresAt` of any file.
 */
export function documentTimes(file: {
  path: string
  /** The front matter of the file. */
  attributes: Record<string, unknown>
  body: string
}): DocumentTimes {
  const property = frontMatterReader(file.attributes)
  const expiresAt = timeOf(property("expiresAt"))
  const root = connectorMirrorRoot(file.path)
  if (root === "slack")
    return {
      createdAt: slackTime(property("threadTs")),
      updatedAt: slackTime(property("latest")),
      expiresAt,
    }
  if (root !== null)
    return {
      createdAt:
        timeOf(property("createdAt")) ?? timeOf(property("createdTime")),
      updatedAt:
        timeOf(property("updatedAt")) ??
        timeOf(property("lastEditedTime")) ??
        timeOf(property("finishedAt")),
      expiresAt,
    }
  const name = file.path.slice(file.path.lastIndexOf("/") + 1)
  const kind = property("kind")
  const decision =
    (typeof kind === "string" && kind.trim().toLowerCase() === "decision") ||
    /^adr-\d/i.test(name)
  return {
    createdAt: decision
      ? (timeOf(property("date")) ??
        timeOf(
          /(?:\*\*Date:\*\*|^Date:)[ \t]*(\d{4}-\d{2}-\d{2})/m.exec(
            file.body,
          )?.[1],
        ))
      : null,
    updatedAt: null,
    expiresAt,
  }
}

/**
 * The times that an agent sees for a file on a branch (CTX-1710): the times
 * that the file states (`documentTimes`), with the Git times of the path on
 * the branch where the file states none.
 *
 * - `createdAt`: the file's own time, else the commit that introduced the
 *   path. For a mirror with no source time, that commit is the first time
 *   that ctxpipe saw the item.
 * - `updatedAt`: for a connector mirror file, the file's own time, else its
 *   `createdAt`. Never the last commit: a change of the mirror format
 *   rewrites each mirror file, so the commit time does not show when the
 *   source changed. For an authored file, the last commit that changed the
 *   path, else its `createdAt`.
 */
export function withGitTimes<T>(
  path: string,
  times: DocumentTimes<T>,
  git: { introducedAt: T | null; lastChangedAt: T | null },
): DocumentTimes<T> {
  const createdAt = times.createdAt ?? git.introducedAt
  const updatedAt =
    connectorMirrorRoot(path) === null
      ? (git.lastChangedAt ?? createdAt)
      : (times.updatedAt ?? createdAt)
  return { createdAt, updatedAt, expiresAt: times.expiresAt }
}

/**
 * A reader of front matter properties by name, with no case and no `_`. The
 * first key in the order of the file wins when two keys are the same.
 */
function frontMatterReader(
  attributes: Record<string, unknown>,
): (name: string) => unknown {
  const keyOf = (name: string) => name.replaceAll("_", "").toLowerCase()
  const values = new Map<string, unknown>()
  for (const [key, value] of Object.entries(attributes))
    if (!values.has(keyOf(key))) values.set(keyOf(key), value)
  return (name) => values.get(keyOf(name))
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

/**
 * A Slack ts (seconds since the epoch) as an ISO time, or null. A value out
 * of the range of a date gives null, so a bad file does not stop a hydrate.
 */
function slackTime(value: unknown): string | null {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const time = new Date(seconds * 1000)
  return Number.isNaN(time.getTime()) ? null : time.toISOString()
}
