import YAML from "yaml"
import { z } from "zod"
import {
  WORKSPACE_WRITE_STATUSES,
  WRITE_STATUS_REASONS,
} from "./write-status.js"

/**
 * The Workspace format file, relative to the Workspace root folder (ADR-053).
 * It holds one integer: the layout version of the Workspace repository. Git
 * is the source of truth. `workspaces.format_version` is only a cache that
 * hydrate writes for each projection. The file is in `.ctxpipe/`, so it is
 * host-only: only bootstrap (in the root commit of a new repository) and an
 * upgrade pull request write it.
 */
export const WORKSPACE_FORMAT_PATH = ".ctxpipe/workspace.yaml"

/**
 * The newest Workspace format that this code reads and writes.
 * 0 = no file (a repository from before Workspaces, or a foreign one).
 * 1 = the main data is exported, and `.ctxpipe/sources.yaml` holds the sources.
 * 2 = one file for each source under `sources/` (CTX-721).
 * 3 = the ownership front matter of ingestion v2 (CTX-640).
 */
export const CODE_FORMAT = 3

/** The cache value for a format file that is not valid. */
export const WORKSPACE_FORMAT_INVALID = -1

/** The format file needs only a few bytes; this cap stops a large blob. */
const WORKSPACE_FORMAT_MAX_BYTES = 4 * 1024

const workspaceFormatSchema = z
  .object({
    // The cache column is a Postgres integer.
    format: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1),
  })
  .strict()

export type WorkspaceFormatRead =
  | { kind: "format"; format: number }
  | { kind: "invalid"; error: string }

/**
 * Read the text of the format file. No file (null) is format 0. A file that
 * is not YAML, or that has a key other than an integer `format`, is invalid.
 */
export function readWorkspaceFormat(text: string | null): WorkspaceFormatRead {
  if (text === null) return { kind: "format", format: 0 }
  if (Buffer.byteLength(text, "utf8") > WORKSPACE_FORMAT_MAX_BYTES)
    return {
      kind: "invalid",
      error: `The file is larger than ${WORKSPACE_FORMAT_MAX_BYTES / 1024} KiB`,
    }
  const document = YAML.parseDocument(text)
  if (document.errors.length)
    return {
      kind: "invalid",
      error: `The file is not valid YAML: ${document.errors[0]?.message}`,
    }
  let value: unknown
  try {
    // The file needs no aliases; a cap stops an alias expansion bomb.
    value = document.toJS({ maxAliasCount: 10 })
  } catch (error) {
    return {
      kind: "invalid",
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const parsed = workspaceFormatSchema.safeParse(value)
  if (!parsed.success)
    return {
      kind: "invalid",
      error: "The file must hold only `format`, an integer of 0 or more",
    }
  return { kind: "format", format: parsed.data.format }
}

/** The value that hydrate writes to `workspaces.format_version`. */
export function workspaceFormatCacheValue(read: WorkspaceFormatRead): number {
  return read.kind === "format" ? read.format : WORKSPACE_FORMAT_INVALID
}

/** The format file that bootstrap writes in the root commit of a new repository. */
export function workspaceFormatFile(format = CODE_FORMAT): {
  path: string
  content: string
} {
  return {
    path: WORKSPACE_FORMAT_PATH,
    content: `# ctx| Workspace format. ctx| changes this file only in an upgrade pull request.\nformat: ${format}\n`,
  }
}

/**
 * The read-only reason that a cached format gives, or null. A format above
 * {@link CODE_FORMAT} needs newer code. A format file that is not valid has
 * no known layout. In both cases hydrate serves the reads, but no write path
 * may change the repository. Null (not read yet) gives no reason.
 */
export function formatReadOnlyReason(
  formatVersion: number | null | undefined,
): string | null {
  if (formatVersion === WORKSPACE_FORMAT_INVALID)
    return WRITE_STATUS_REASONS.formatInvalid
  if (typeof formatVersion === "number" && formatVersion > CODE_FORMAT)
    return WRITE_STATUS_REASONS.formatAhead
  return null
}

/**
 * The Workspace row with the format gate applied. The stored write status is
 * the result of the GitHub probe; the format gate is on top of it. Each
 * write path reads `writeStatus`, so a Workspace with a format reason is
 * `read_only` with that reason for all of them. The stored columns do not
 * change, so a new probe or a format change takes effect at the next read.
 */
export function withFormatWriteGate<
  T extends {
    writeStatus: string
    readOnlyReason: string | null
    formatVersion: number | null
  },
>(row: T): T {
  const reason = formatReadOnlyReason(row.formatVersion)
  return reason
    ? {
        ...row,
        writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
        readOnlyReason: reason,
      }
    : row
}

/**
 * True when hydrate must queue an upgrade scan after it cached `next` over
 * `previous`. A changed format can complete an upgrade pull request, and it
 * can lift the format gate, so the write jobs that the gate held must
 * resume. The first read of a repository with no file (null to 0) changes
 * nothing: a null cache gives no gate, and no upgrade ends at format 0.
 */
export function formatChangeNeedsScan(
  previous: number | null,
  next: number,
): boolean {
  return previous !== next && !(previous === null && next === 0)
}
