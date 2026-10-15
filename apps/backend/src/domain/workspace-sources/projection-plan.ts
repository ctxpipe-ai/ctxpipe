import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { githubSourceScopeRepositories } from "./providers/github.js"
import { checkSourcePath, SOURCE_FILE_SCOPES } from "./source-file.js"
import { parseSourceFile } from "./source-file-text.js"
import {
  parseSourceEntry,
  type SourceEntry,
  type SourceProvider,
  type SourceStatus,
  sourcesFileSchema,
} from "./sources-file.js"
import { parseSourcesYaml } from "./sources-yaml.js"

/**
 * The reserved key of the row that records a file-level error of
 * `.ctxpipe/sources.yaml`. It goes away with the YAML read (CTX-721 T11).
 */
export const FILE_ERROR_SOURCE_KEY = ".file"

export type PlannedSourceRow = {
  sourceKey: string
  provider: SourceProvider | null
  connectionId: string | null
  scope: Record<string, unknown>
  status: SourceStatus
  statusDetail: string | null
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

/** One blob under `sources/`, with its path relative to the Workspace root folder. */
export type SourceFileBlob = { path: string; text: string }

/**
 * A parsed source before the connection checks: a valid entry, or the
 * fields of an invalid one with its reason.
 */
type ParsedSource =
  | { entry: SourceEntry }
  | {
      entry: null
      sourceKey: string
      provider: SourceProvider | null
      connectionId: string | null
      /** The scope of the first entry of a duplicate YAML id. */
      scope?: Record<string, unknown>
      detail: string
    }

/**
 * Turn the sources of one Workspace revision into the rows of its
 * projection (ADR-050, revision 2026-10-16). Each file under `sources/`
 * gives one row, keyed by its path. Until the conversion is done (CTX-721
 * T11), the entries of `.ctxpipe/sources.yaml` (`text`) also give rows,
 * keyed by their ids. Each `repositories/*.md` file in `leftoverFiles` (a
 * file that the ADR-050 upgrade cannot move) gets an invalid row, keyed by
 * its path.
 *
 * Then the rules across sources apply to the rows of both inputs: a GitHub
 * source must not name the Workspace repository, two `ok` sources must not
 * name the same repository, and the managed paths of two `ok` sources must
 * not overlap. Of two sources in conflict, the one in `previousOkKeys` (the
 * `ok` rows of the previous projected revision) stays `ok`; else the first
 * key in byte order stays `ok`. The other becomes `invalid`.
 */
export async function planSourceRows(input: {
  text: string | null
  /** Every blob under `sources/` at the revision. */
  files?: ReadonlyArray<SourceFileBlob>
  connections: ReadonlyMap<string, SourceConnection>
  checkAccess?: SourceAccessCheck
  leftoverFiles?: ReadonlyArray<{ path: string; reason: string }>
  /** The Workspace repository URL; a GitHub source must not name it. */
  workspaceUrl?: string | null
  previousOkKeys?: ReadonlySet<string>
  /** The managed paths of a valid source (the provider adapter's). */
  managedPaths?: (entry: SourceEntry) => readonly string[]
}): Promise<PlannedSourceRow[]> {
  const legacy = planLegacyYamlSources(input.text)
  const parsed = [
    ...legacy.sources,
    ...[...(input.files ?? [])]
      .sort((a, b) => compareKeys(a.path, b.path))
      .map(parseSourceBlob),
  ]
  const rows: PlannedSourceRow[] = [...legacy.fileErrors]
  for (const source of parsed) rows.push(await checkSource(source, input))
  applyCrossSourceRules(rows, parsed, input)
  return [
    ...rows,
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

/** Byte order of two ASCII keys (paths and YAML ids are ASCII). */
function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

function parseSourceBlob(blob: SourceFileBlob): ParsedSource {
  if (!blob.path.endsWith(".md")) {
    const checked = checkSourcePath(blob.path)
    return {
      entry: null,
      sourceKey: blob.path,
      provider: null,
      connectionId: null,
      detail: checked.ok ? "A source file name ends with .md" : checked.reason,
    }
  }
  const parsed = parseSourceFile(blob.path, blob.text)
  if (!parsed.ok)
    return {
      entry: null,
      sourceKey: blob.path,
      provider: parsed.provider,
      connectionId: parsed.connectionId,
      detail: parsed.detail,
    }
  return {
    entry: {
      key: parsed.source.path,
      provider: parsed.source.provider,
      connectionId: parsed.source.connectionId,
      scope: parsed.source.scope,
    },
  }
}

/**
 * The sources of `.ctxpipe/sources.yaml` (the dual read until CTX-721 T11
 * deletes this function), and the reserved row of a file-level error.
 */
function planLegacyYamlSources(text: string | null): {
  sources: ParsedSource[]
  fileErrors: PlannedSourceRow[]
} {
  if (text === null) return { sources: [], fileErrors: [] }
  let document: unknown
  try {
    document = parseSourcesYaml(text)
  } catch (error) {
    return {
      sources: [],
      fileErrors: fileError(
        error instanceof Error ? error.message : String(error),
      ),
    }
  }
  if (document === null || document === undefined)
    return { sources: [], fileErrors: [] }
  const file = sourcesFileSchema.safeParse(document)
  if (!file.success)
    return {
      sources: [],
      fileErrors: fileError(
        `The file does not match version 1: ${file.error.issues.map((issue) => issue.message).join("; ")}`,
      ),
    }
  const sources = new Map<string, ParsedSource>()
  for (const [index, raw] of file.data.sources.entries()) {
    const parsed = parseSourceEntry(raw)
    const sourceKey = parsed.ok
      ? parsed.entry.key
      : (parsed.key ?? `.entry-${index + 1}`)
    const first = sources.get(sourceKey)
    if (first) {
      sources.set(sourceKey, {
        entry: null,
        sourceKey,
        provider: first.entry ? first.entry.provider : first.provider,
        connectionId: first.entry
          ? first.entry.connectionId
          : first.connectionId,
        detail: `The id "${sourceKey}" is used by more than one entry`,
        ...(first.entry ? { scope: first.entry.scope } : {}),
      })
      continue
    }
    sources.set(
      sourceKey,
      parsed.ok
        ? { entry: parsed.entry }
        : {
            entry: null,
            sourceKey,
            provider: parsed.provider,
            connectionId: parsed.connectionId,
            detail: parsed.detail,
          },
    )
  }
  return { sources: [...sources.values()], fileErrors: [] }
}

/** The status of one source by itself: parse, connection, and access. */
async function checkSource(
  source: ParsedSource,
  input: {
    connections: ReadonlyMap<string, SourceConnection>
    checkAccess?: SourceAccessCheck
    workspaceUrl?: string | null
  },
): Promise<PlannedSourceRow> {
  if (!source.entry)
    return {
      sourceKey: source.sourceKey,
      provider: source.provider,
      connectionId: source.connectionId,
      scope: source.scope ?? {},
      status: "invalid",
      statusDetail: source.detail,
    }
  const { entry } = source
  const base = {
    sourceKey: entry.key,
    provider: entry.provider,
    connectionId: entry.connectionId,
    scope: entry.scope,
  }
  const connection = input.connections.get(entry.connectionId)
  if (!connection)
    return {
      ...base,
      status: "connection_missing",
      statusDetail: "The connection does not exist in this organization",
    }
  const expectedType = SOURCE_FILE_SCOPES[entry.provider].connectionType
  if (connection.type !== expectedType)
    return {
      ...base,
      status: "invalid",
      statusDetail: `The connection is a ${connection.type} connection, not ${expectedType}`,
    }
  if (input.workspaceUrl && entry.provider === "github") {
    const workspace = repositoryKey(input.workspaceUrl)
    if (
      githubRepositoryKeys(entry).some((repository) => repository === workspace)
    )
      return {
        ...base,
        status: "invalid",
        statusDetail:
          "The source names the Workspace repository. A Workspace cannot link its own repository.",
      }
  }
  const accessIssue = input.checkAccess
    ? await input.checkAccess(entry, connection)
    : null
  return typeof accessIssue === "string"
    ? { ...base, status: "out_of_access", statusDetail: accessIssue }
    : { ...base, status: "ok", statusDetail: accessIssue?.okDetail ?? null }
}

function repositoryKey(url: string): string {
  return normalizeWorkspaceRepositoryUrl(url).toLowerCase()
}

function githubRepositoryKeys(entry: SourceEntry): string[] {
  return githubSourceScopeRepositories(entry.scope).map(({ name }) =>
    repositoryKey(`https://github.com/${name}`),
  )
}

/** True when one managed path is equal to, or below, the other. */
function pathsOverlap(a: string, b: string): boolean {
  const folder = (path: string) => (path.endsWith("/") ? path : `${path}/`)
  return folder(a).startsWith(folder(b)) || folder(b).startsWith(folder(a))
}

/**
 * Make each `ok` row that conflicts with a stronger `ok` row invalid. A row
 * of `previousOkKeys` is stronger than a new row; of two such rows, or two
 * new rows, the first key in byte order is stronger.
 */
function applyCrossSourceRules(
  rows: PlannedSourceRow[],
  parsed: readonly ParsedSource[],
  input: {
    previousOkKeys?: ReadonlySet<string>
    managedPaths?: (entry: SourceEntry) => readonly string[]
  },
): void {
  const entries = new Map(
    parsed.flatMap((source) =>
      source.entry ? [[source.entry.key, source.entry] as const] : [],
    ),
  )
  const wasOk = (key: string) => input.previousOkKeys?.has(key) ?? false
  const candidates = rows
    .filter((row) => row.status === "ok" && entries.has(row.sourceKey))
    .sort(
      (a, b) =>
        Number(wasOk(b.sourceKey)) - Number(wasOk(a.sourceKey)) ||
        compareKeys(a.sourceKey, b.sourceKey),
    )
  const repositories = new Map<string, string>()
  const managed: Array<{ path: string; sourceKey: string }> = []
  for (const row of candidates) {
    const entry = entries.get(row.sourceKey)
    if (!entry) continue
    const ownRepositories =
      entry.provider === "github" ? githubRepositoryKeys(entry) : []
    const ownPaths = input.managedPaths?.(entry) ?? []
    const repositoryConflict = ownRepositories
      .map((repository) => repositories.get(repository))
      .find((key) => key !== undefined)
    const pathConflict = managed.find((other) =>
      ownPaths.some((path) => pathsOverlap(path, other.path)),
    )
    if (repositoryConflict !== undefined) {
      row.status = "invalid"
      row.statusDetail = `${repositoryConflict} already links this repository`
      continue
    }
    if (pathConflict) {
      row.status = "invalid"
      row.statusDetail = `${pathConflict.sourceKey} already syncs ${pathConflict.path}, which overlaps this source`
      continue
    }
    for (const repository of ownRepositories)
      repositories.set(repository, row.sourceKey)
    for (const path of ownPaths)
      managed.push({ path, sourceKey: row.sourceKey })
  }
}
