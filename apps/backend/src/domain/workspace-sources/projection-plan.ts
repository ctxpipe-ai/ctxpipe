import { isDeepStrictEqual } from "node:util"
import {
  parseSourceEntry,
  SOURCE_SCOPES,
  type SourceEntry,
  type SourceProvider,
  type SourceStatus,
  sourcesFileSchema,
} from "./sources-file.js"
import { parseSourcesYaml } from "./sources-yaml.js"

/** The reserved key of the row that records a file-level error. */
export const FILE_ERROR_SOURCE_KEY = ".file"

/** The key prefix of an entry whose id cannot be read. */
const UNREADABLE_ID_KEY_PREFIX = ".entry-"

export type PlannedSourceRow = {
  sourceKey: string
  provider: SourceProvider | null
  connectionId: string | null
  scope: Record<string, unknown>
  status: SourceStatus
  statusDetail: string | null
}

/**
 * Tell why a projection cannot know if a source that is not in its rows left
 * the file, or return null. While the file cannot be read, or while an entry
 * has an id that cannot be read, a source that seems removed can still be in
 * the file. The projection then keeps its row as `invalid`, with this detail,
 * and its files stay.
 */
export function unmatchedSourceDetail(
  rows: readonly PlannedSourceRow[],
): string | null {
  if (rows.some((row) => row.sourceKey === FILE_ERROR_SOURCE_KEY))
    return "The sources file cannot be read"
  if (rows.some((row) => row.sourceKey.startsWith(UNREADABLE_ID_KEY_PREFIX)))
    return "An entry without a readable id can be this source"
  return null
}

export type SourceConnection = { id: string; type: string }

/**
 * Tell why a valid entry is out of its connection's reach, or return null.
 * `okDetail` keeps the entry `ok` with a detail (usable in part). The
 * provider adapter supplies this; without it every valid entry is `ok`.
 */
export type SourceAccessCheck = (
  entry: SourceEntry,
  connection: SourceConnection,
) => Promise<string | { okDetail: string } | null>

function fileError(detail: string): PlannedSourceRow[] {
  return [
    {
      sourceKey: FILE_ERROR_SOURCE_KEY,
      provider: null,
      connectionId: null,
      scope: {},
      status: "invalid",
      statusDetail: detail,
    },
  ]
}

/**
 * Turn the text of `.ctxpipe/sources.yaml` into the rows of its projection.
 * Each `repositories/*.md` file in `leftoverFiles` (a file that the ADR-050
 * upgrade cannot move into the sources file) gets an invalid row, keyed by
 * its path, so that the Workspace shows it with the source errors.
 */
export async function planSourceRows(input: {
  text: string | null
  connections: ReadonlyMap<string, SourceConnection>
  checkAccess?: SourceAccessCheck
  leftoverFiles?: ReadonlyArray<{ path: string; reason: string }>
}): Promise<PlannedSourceRow[]> {
  return [
    ...(await planEntryRows(input)),
    ...(input.leftoverFiles ?? []).map((file) => ({
      sourceKey: file.path,
      provider: null,
      connectionId: null,
      scope: {},
      status: "invalid" as const,
      statusDetail: `${file.path}: ${file.reason}. Move the link into .ctxpipe/sources.yaml or remove the file.`,
    })),
  ]
}

async function planEntryRows(input: {
  text: string | null
  connections: ReadonlyMap<string, SourceConnection>
  checkAccess?: SourceAccessCheck
}): Promise<PlannedSourceRow[]> {
  if (input.text === null) return []
  let document: unknown
  try {
    document = parseSourcesYaml(input.text)
  } catch (error) {
    return fileError(error instanceof Error ? error.message : String(error))
  }
  if (document === null || document === undefined) return []
  const file = sourcesFileSchema.safeParse(document)
  if (!file.success)
    return fileError(
      `The file does not match version 1: ${file.error.issues.map((issue) => issue.message).join("; ")}`,
    )

  const rows = new Map<string, PlannedSourceRow>()
  for (const [index, raw] of file.data.sources.entries()) {
    const parsed = parseSourceEntry(raw)
    const sourceKey = parsed.ok
      ? parsed.entry.key
      : (parsed.key ?? `${UNREADABLE_ID_KEY_PREFIX}${index + 1}`)
    if (rows.has(sourceKey)) {
      const first = rows.get(sourceKey)
      if (first)
        rows.set(sourceKey, {
          ...first,
          status: "invalid",
          statusDetail: `The id "${sourceKey}" is used by more than one entry`,
        })
      continue
    }
    if (!parsed.ok) {
      rows.set(sourceKey, {
        sourceKey,
        provider: parsed.provider,
        connectionId: parsed.connectionId,
        scope: {},
        status: "invalid",
        statusDetail: parsed.detail,
      })
      continue
    }
    const { entry } = parsed
    const base = {
      sourceKey,
      provider: entry.provider,
      connectionId: entry.connectionId,
      scope: entry.scope,
    }
    const connection = input.connections.get(entry.connectionId)
    if (!connection) {
      rows.set(sourceKey, {
        ...base,
        status: "connection_missing",
        statusDetail: "The connection does not exist in this organization",
      })
      continue
    }
    const expectedType = SOURCE_SCOPES[entry.provider].connectionType
    if (connection.type !== expectedType) {
      rows.set(sourceKey, {
        ...base,
        status: "invalid",
        statusDetail: `The connection is a ${connection.type} connection, not ${expectedType}`,
      })
      continue
    }
    const accessIssue = input.checkAccess
      ? await input.checkAccess(entry, connection)
      : null
    rows.set(
      sourceKey,
      typeof accessIssue === "string"
        ? { ...base, status: "out_of_access", statusDetail: accessIssue }
        : {
            ...base,
            status: "ok",
            statusDetail: accessIssue?.okDetail ?? null,
          },
    )
  }
  return [...rows.values()]
}

/**
 * Tell if the sources file `text` has none of `targets`, by provider,
 * connection and scope. A file or an entry id that cannot be read can hold a
 * target, so then the result is false.
 */
export async function sourcesFileHasNone(
  text: string | null,
  targets: ReadonlyArray<{
    provider: string | null
    connectionId: string | null
    scope: unknown
  }>,
): Promise<boolean> {
  const rows = await planSourceRows({ text, connections: new Map() })
  return (
    unmatchedSourceDetail(rows) === null &&
    !rows.some((row) =>
      targets.some(
        (target) =>
          target.provider === row.provider &&
          target.connectionId === row.connectionId &&
          isDeepStrictEqual(target.scope, row.scope),
      ),
    )
  )
}
