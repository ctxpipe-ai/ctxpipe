import YAML from "yaml"
import { z } from "zod"

import {
  WORKSPACE_WRITE_STATUSES,
  WRITE_STATUS_REASONS,
} from "./write-status.js"

/**
 * The Workspace format file, relative to the Workspace root folder (ADR-053).
 * It holds the layout version of the Workspace repository (`format`) and the
 * optional upgrade setting of the Workspace (`upgrades`). Git
 * is the source of truth. `workspaces.format_version` is only a cache that
 * hydrate writes for each projection. The file is in `.ctxpipe/`, so it is
 * host-only: only the bootstrap commit and an upgrade pull request write the
 * format, and only the Always update action writes the setting. Bootstrap writes it on an empty repository, and on a repository with no
 * ctxpipe content (see {@link hasCtxpipeContent}).
 */
export const WORKSPACE_FORMAT_PATH = ".ctxpipe/workspace.yaml"

/**
 * The newest Workspace format that this code reads and writes.
 * 0 = no file in a repository with ctxpipe content (from before Workspaces).
 * 1 = the main data is exported, and `.ctxpipe/sources.yaml` holds the sources.
 * 2 = one file for each source under `sources/` (CTX-721).
 * 3 = the ownership front matter of ingestion v2 (CTX-640).
 */
export const CODE_FORMAT = 3

/** The first format with one file for each source under `sources/` (upgrade step 2). */
export const SOURCE_FILES_FORMAT = 2

/** The first format with ownership front matter (upgrade step 3). Ingestion v2 publishes from here. */
export const INGESTION_V2_PUBLISH_FORMAT = 3

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
    upgrades: z.enum(["manual", "automatic"]).optional(),
  })
  .strict()

/**
 * `automatic`: ctxpipe starts each upgrade item of the Workspace when the scan
 * finds it. `manual` (also no key): an owner or admin starts each item.
 */
export type WorkspaceUpgradeMode = "manual" | "automatic"

type WorkspaceFormatRead =
  | { kind: "format"; format: number; upgrades: WorkspaceUpgradeMode }
  | { kind: "invalid"; error: string }

/**
 * Read the text of the format file. No file (null) is format 0. A file that
 * is not YAML, or that has a key other than an integer `format`, is invalid.
 */
export function readWorkspaceFormat(text: string | null): WorkspaceFormatRead {
  if (text === null) return { kind: "format", format: 0, upgrades: "manual" }
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
      error:
        "The file must hold `format`, an integer of 0 or more, and optionally `upgrades: manual` or `upgrades: automatic`",
    }
  return {
    kind: "format",
    format: parsed.data.format,
    upgrades: parsed.data.upgrades ?? "manual",
  }
}

/**
 * The text of the format file with new values for `format` or `upgrades`.
 * It keeps the comments and the other value of `current`. No file
 * (null) starts from format 0. Null when `current` is not valid.
 */
export function withWorkspaceFormatFields(
  current: string | null,
  fields: { format?: number; upgrades?: WorkspaceUpgradeMode },
): string | null {
  const read = readWorkspaceFormat(current)
  if (read.kind === "invalid") return null
  const document = YAML.parseDocument(
    current ?? workspaceFormatFile(read.format).content,
  )
  if (fields.format !== undefined) document.set("format", fields.format)
  if (fields.upgrades !== undefined) document.set("upgrades", fields.upgrades)
  return document.toString()
}

/** The format value of a read: an integer, or {@link WORKSPACE_FORMAT_INVALID}. */
export function workspaceFormatCacheValue(read: WorkspaceFormatRead): number {
  return read.kind === "format" ? read.format : WORKSPACE_FORMAT_INVALID
}

/**
 * The value that hydrate writes to `workspaces.format_version`, from the
 * format file text and the paths of the tree. When ctxpipe can write, a tree
 * with no format file and no ctxpipe content gets null (not known yet), not 0:
 * the bootstrap commit adds the format file to that repository (see
 * {@link hasCtxpipeContent}), and its hydrate caches the format. A cached 0
 * before that commit would ask for an upgrade that the repository does not
 * need. A read-only repository gets no bootstrap commit, so it stays at 0.
 */
export function workspaceFormatCache(input: {
  text: string | null
  paths: Iterable<string>
  writeStatus: string
}): number | null {
  if (
    input.text === null &&
    input.writeStatus !== WORKSPACE_WRITE_STATUSES.read_only &&
    !hasCtxpipeContent(input.paths)
  )
    return null
  return workspaceFormatCacheValue(readWorkspaceFormat(input.text))
}

/**
 * True when one of `paths` is ctxpipe content: a file below `.ctxpipe/`,
 * `sources/` or `repositories/`. The paths are relative to the Workspace root
 * folder. A repository with no ctxpipe content is new (for example a new GitHub
 * repository with only a README), so bootstrap writes the format file in its
 * commit. A repository with ctxpipe content keeps its format, and the upgrade
 * pull request changes it (ADR-053).
 */
export function hasCtxpipeContent(paths: Iterable<string>): boolean {
  for (const path of paths)
    if (CTXPIPE_CONTENT_FOLDERS.some((folder) => path.startsWith(`${folder}/`)))
      return true
  return false
}

/** The folders that hold ctxpipe content, relative to the Workspace root folder. */
export const CTXPIPE_CONTENT_FOLDERS = [".ctxpipe", "sources", "repositories"]

/** The format file that bootstrap writes on a repository with no ctxpipe content. */
export function workspaceFormatFile(format = CODE_FORMAT): {
  path: string
  content: string
} {
  return {
    path: WORKSPACE_FORMAT_PATH,
    content: `# ctxpipe Workspace format. ctxpipe changes this file only in an upgrade pull request.\nformat: ${format}\n`,
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
 * True when `format` is known and is `min` or more. A format that is not
 * known (null: not read yet) is not at least `min`, so a caller that needs a
 * format waits or refuses. A format file that is not valid
 * ({@link WORKSPACE_FORMAT_INVALID}) is also not at least `min`. This is the
 * one format check for each "has the upgrade" and "needs the upgrade" rule.
 */
export function workspaceFormatAtLeast(
  format: number | null,
  min: number,
): boolean {
  return format !== null && format >= 0 && format >= min
}

/** The error text of a source writer on a Workspace below format 2. */
export const UPGRADE_FIRST_MESSAGE =
  "Upgrade this Workspace first. Its repository does not use one file for each source yet. Run the Workspace upgrade, then try again."

/**
 * True when hydrate must queue an upgrade scan after it cached `next` over
 * `previous`. A changed format can complete an upgrade pull request, and it
 * can lift the format gate, so the write jobs that the gate held must
 * resume. The first read is a change too, also null to 0: a repository with
 * no format file is below the newest format, so it needs an upgrade item. A
 * Workspace that joins after the scan of a release gets no other scan.
 * Null to null (no format yet) is not a change.
 */
export function formatChangeNeedsScan(
  previous: number | null,
  next: number | null,
): boolean {
  return previous !== next
}
