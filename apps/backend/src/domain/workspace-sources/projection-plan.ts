import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { githubSourceScopeRepositories } from "./providers/github.js"
import {
  checkSourcePath,
  SOURCE_FILE_MAX_BYTES,
  SOURCE_FILE_SCOPES,
  SOURCE_FILES_FOLDER,
} from "./source-file.js"
import { parseSourceFile } from "./source-file-text.js"
import {
  parseSourceEntry,
  type SourceEntry,
  type SourceProvider,
  type SourceStatus,
  sourceProviderSchema,
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

/**
 * One blob under `sources/`, with its path relative to the Workspace root
 * folder. `omitted` tells why the tree read did not read the text: the blob
 * is larger than the limit, or it is not text.
 */
export type SourceFileBlob = {
  path: string
  text: string
  omitted?: "too_large" | "binary"
}

/**
 * A row of the previous projected revision. Its status and scope decide the
 * winner of a conflict across sources.
 */
export type PreviousSourceRow = {
  sourceKey: string
  provider: string | null
  connectionId: string | null
  scope: unknown
  status: string
}

/**
 * The statuses of a row that holds its repositories and managed paths in the
 * rules across sources. A row keeps the hold while its access or its
 * connection is gone for a time, so another source cannot take its place.
 */
const HOLDING_STATUSES: ReadonlySet<string> = new Set<SourceStatus>([
  "ok",
  "out_of_access",
  "connection_missing",
])

/**
 * A parsed source before the connection checks: a valid entry, or the
 * fields of an invalid one with its reason.
 */
type ParsedSource =
  | { entry: SourceEntry; origin: "file" | "yaml" }
  | {
      entry: null
      sourceKey: string
      provider: SourceProvider | null
      connectionId: string | null
      /** The scope, when it parses (for a duplicate YAML id: of the first entry). */
      scope?: Record<string, unknown>
      detail: string
    }

/** The input of {@link resolveSourceRows}. */
export type SourceRowsInput = {
  text: string | null
  /** Every blob under `sources/` at the revision. */
  files?: ReadonlyArray<SourceFileBlob>
  /**
   * The org's connections. Null when the caller does not know them: then each
   * connection exists and has the type of its provider.
   */
  connections: ReadonlyMap<string, SourceConnection> | null
  leftoverFiles?: ReadonlyArray<{ path: string; reason: string }>
  /** The Workspace repository URL; a GitHub source must not name it. */
  workspaceUrl?: string | null
  /** The rows of the previous projected revision. */
  previousRows?: ReadonlyArray<PreviousSourceRow>
  /** The managed paths of a valid source (the provider adapter's). */
  managedPaths?: (entry: SourceEntry) => readonly string[]
}

/**
 * Turn the sources of one Workspace revision into the rows of its
 * projection (ADR-050, revision 2026-10-16), with no access check. Each file
 * under `sources/` gives one row, keyed by its path. Until the conversion is
 * done (CTX-721 T11), the entries of `.ctxpipe/sources.yaml` (`text`) also
 * give rows, keyed by their ids. Each `repositories/*.md` file in
 * `leftoverFiles` (a file that the ADR-050 upgrade cannot move) gets an
 * invalid row, keyed by its path.
 *
 * Then the rules across sources apply to the rows of both inputs: a GitHub
 * source file must not name the Workspace repository (a YAML entry only
 * skips it), two sources must not name the same repository, and the managed
 * paths of two sources must not overlap. Only a row with a status in
 * {@link HOLDING_STATUSES} takes part. Of two sources in conflict, the one
 * that held the repository or path at the previous revision stays; else the
 * first key in byte order stays. The other becomes `invalid`.
 *
 * The projection and the linked set of hydrate both use this function, so
 * they agree on each winner.
 */
export function resolveSourceRows(input: SourceRowsInput): PlannedSourceRow[] {
  return resolve(input).rows
}

/**
 * {@link resolveSourceRows}, then the access check of each `ok` row. A row
 * out of its connection's reach becomes `out_of_access`. It keeps its hold,
 * so the access check does not change the winner of a conflict.
 */
export async function planSourceRows(
  input: SourceRowsInput & {
    connections: ReadonlyMap<string, SourceConnection>
    checkAccess?: SourceAccessCheck
  },
): Promise<PlannedSourceRow[]> {
  const { rows, entries } = resolve(input)
  const checkAccess = input.checkAccess
  const connections = input.connections
  if (!checkAccess) return rows
  for (const row of rows) {
    const entry = entries.get(row.sourceKey)
    const connection = entry && connections.get(entry.connectionId)
    if (row.status !== "ok" || !entry || !connection) continue
    const accessIssue = await checkAccess(entry, connection)
    if (typeof accessIssue === "string") {
      row.status = "out_of_access"
      row.statusDetail = accessIssue
    } else row.statusDetail = accessIssue?.okDetail ?? row.statusDetail
  }
  return rows
}

function resolve(input: SourceRowsInput): {
  rows: PlannedSourceRow[]
  entries: Map<string, SourceEntry>
} {
  const legacy = planLegacyYamlSources(input.text)
  const parsed = [
    ...legacy.sources,
    ...[...(input.files ?? [])]
      .sort((a, b) => compareKeys(a.path, b.path))
      .map(parseSourceBlob),
  ]
  const rows: PlannedSourceRow[] = [...legacy.fileErrors]
  for (const source of parsed) rows.push(checkSource(source, input))
  const entries = new Map(
    parsed.flatMap((source) =>
      source.entry ? [[source.entry.key, source.entry] as const] : [],
    ),
  )
  applyCrossSourceRules(
    rows,
    entries,
    new Set(
      parsed.flatMap((source) =>
        source.entry && source.origin === "yaml" ? [source.entry.key] : [],
      ),
    ),
    input,
  )
  rows.push(
    ...(input.leftoverFiles ?? []).map((file) => ({
      sourceKey: file.path,
      provider: null,
      connectionId: null,
      scope: {},
      status: "invalid" as const,
      statusDetail: `${file.path}: ${file.reason}. Move the link into a file under ${SOURCE_FILES_FOLDER}/github/ or remove the file.`,
    })),
  )
  return { rows, entries }
}

/** Byte order of two ASCII keys (paths and YAML ids are ASCII). */
function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

function parseSourceBlob(blob: SourceFileBlob): ParsedSource {
  const invalid = (detail: string): ParsedSource => {
    const checked = checkSourcePath(blob.path)
    return {
      entry: null,
      sourceKey: blob.path,
      provider: checked.ok ? checked.provider : null,
      connectionId: null,
      detail,
    }
  }
  const checked = checkSourcePath(blob.path)
  if (!checked.ok && !blob.path.endsWith(".md")) return invalid(checked.reason)
  if (blob.omitted === "too_large")
    return invalid(
      `The file is larger than ${SOURCE_FILE_MAX_BYTES / 1024} KiB`,
    )
  if (blob.omitted === "binary") return invalid("The file is not text")
  const parsed = parseSourceFile(blob.path, blob.text)
  if (!parsed.ok)
    return {
      entry: null,
      sourceKey: blob.path,
      provider: parsed.provider,
      connectionId: parsed.connectionId,
      detail: parsed.detail,
      ...(parsed.scope ? { scope: parsed.scope } : {}),
    }
  return {
    entry: {
      key: parsed.source.path,
      provider: parsed.source.provider,
      connectionId: parsed.source.connectionId,
      scope: parsed.source.scope,
    },
    origin: "file",
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
        ? { entry: parsed.entry, origin: "yaml" }
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

/** The status of one source by itself: parse, connection, and Workspace repository. */
function checkSource(
  source: ParsedSource,
  input: {
    connections: ReadonlyMap<string, SourceConnection> | null
    workspaceUrl?: string | null
  },
): PlannedSourceRow {
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
  const expectedType = SOURCE_FILE_SCOPES[entry.provider].connectionType
  const connection = input.connections
    ? input.connections.get(entry.connectionId)
    : { id: entry.connectionId, type: expectedType }
  if (!connection)
    return {
      ...base,
      status: "connection_missing",
      statusDetail: "The connection does not exist in this organization",
    }
  if (connection.type !== expectedType)
    return {
      ...base,
      status: "invalid",
      statusDetail: `The connection is a ${connection.type} connection, not ${expectedType}`,
    }
  // A YAML entry that names the Workspace repository stays ok and links only
  // its other repositories, as before the source files (ADR-050 decision 15).
  if (
    source.origin === "file" &&
    input.workspaceUrl &&
    entry.provider === "github" &&
    githubRepositoryKeys(entry).includes(repositoryKey(input.workspaceUrl))
  )
    return {
      ...base,
      status: "invalid",
      statusDetail:
        "The source names the Workspace repository. A Workspace cannot link its own repository.",
    }
  return { ...base, status: "ok", statusDetail: null }
}

function repositoryKey(url: string): string {
  return normalizeWorkspaceRepositoryUrl(url).toLowerCase()
}

function githubRepositoryKeys(entry: { scope: unknown }): string[] {
  return githubSourceScopeRepositories(entry.scope).map(({ name }) =>
    repositoryKey(`https://github.com/${name}`),
  )
}

/** True when one managed path is equal to, or below, the other. */
function pathsOverlap(a: string, b: string): boolean {
  const folder = (path: string) => (path.endsWith("/") ? path : `${path}/`)
  return folder(a).startsWith(folder(b)) || folder(b).startsWith(folder(a))
}

/** What a source holds: its repositories and its managed paths. */
type Holds = { repositories: string[]; paths: readonly string[] }

function holdsOverlap(a: Holds, b: Holds): boolean {
  return (
    a.repositories.some((repository) => b.repositories.includes(repository)) ||
    a.paths.some((path) => b.paths.some((other) => pathsOverlap(path, other)))
  )
}

/**
 * Make each holding row that conflicts with a stronger holding row invalid.
 * A row that held at the previous revision is the strongest. A new key that
 * holds what a removed holding row held (a rename) is next. Of two rows of
 * the same strength, the first key in byte order is stronger.
 */
function applyCrossSourceRules(
  rows: PlannedSourceRow[],
  entries: ReadonlyMap<string, SourceEntry>,
  yamlKeys: ReadonlySet<string>,
  input: Pick<
    SourceRowsInput,
    "previousRows" | "managedPaths" | "workspaceUrl"
  >,
): void {
  const workspace = input.workspaceUrl
    ? repositoryKey(input.workspaceUrl)
    : null
  const holdsOf = (entry: SourceEntry): Holds => ({
    repositories:
      entry.provider === "github"
        ? githubRepositoryKeys(entry).filter(
            (repository) => repository !== workspace,
          )
        : [],
    paths: input.managedPaths?.(entry) ?? [],
  })
  const previous = input.previousRows ?? []
  const currentKeys = new Set(rows.map((row) => row.sourceKey))
  const previousKeys = new Set(previous.map((row) => row.sourceKey))
  const heldBefore = previous.filter((row) => HOLDING_STATUSES.has(row.status))
  const heldKeys = new Set(heldBefore.map((row) => row.sourceKey))
  const removedHolds = heldBefore.flatMap((row) => {
    const provider = sourceProviderSchema.safeParse(row.provider)
    if (!provider.success || currentKeys.has(row.sourceKey)) return []
    const scope =
      row.scope && typeof row.scope === "object"
        ? (row.scope as Record<string, unknown>)
        : {}
    return [
      holdsOf({
        key: row.sourceKey,
        provider: provider.data,
        connectionId: row.connectionId ?? "",
        scope,
      }),
    ]
  })
  const candidates = rows.flatMap((row) => {
    const entry = entries.get(row.sourceKey)
    if (!entry || !HOLDING_STATUSES.has(row.status)) return []
    const holds = holdsOf(entry)
    const strength = heldKeys.has(row.sourceKey)
      ? 2
      : !previousKeys.has(row.sourceKey) &&
          removedHolds.some((removed) => holdsOverlap(removed, holds))
        ? 1
        : 0
    return [{ row, holds, strength }]
  })
  candidates.sort(
    (a, b) =>
      b.strength - a.strength || compareKeys(a.row.sourceKey, b.row.sourceKey),
  )
  // A YAML entry may name many repositories. In a conflict on one of them it
  // stays ok and skips only that repository (ADR-050 decision 6). Of two YAML
  // entries, the earlier entry in the file links it, as before the source
  // files. A source file names one repository, so it becomes invalid.
  const yamlIndex = new Map(
    rows.flatMap((row, index) =>
      yamlKeys.has(row.sourceKey) ? [[row.sourceKey, index] as const] : [],
    ),
  )
  const repositories = new Map<string, string>()
  const skips = new Map<string, Array<{ repository: string; by: string }>>()
  const skip = (sourceKey: string, repository: string, by: string) =>
    skips.set(sourceKey, [...(skips.get(sourceKey) ?? []), { repository, by }])
  const managed: Array<{ path: string; sourceKey: string }> = []
  for (const { row, holds } of candidates) {
    const index = yamlIndex.get(row.sourceKey)
    const pathConflict = managed.find((other) =>
      holds.paths.some((path) => pathsOverlap(path, other.path)),
    )
    if (index === undefined) {
      const repositoryConflict = holds.repositories
        .map((repository) => repositories.get(repository))
        .find((key) => key !== undefined)
      if (repositoryConflict !== undefined) {
        row.status = "invalid"
        row.statusDetail = `${repositoryConflict} already links this repository`
        continue
      }
    }
    if (pathConflict) {
      row.status = "invalid"
      row.statusDetail = `${pathConflict.sourceKey} already syncs ${pathConflict.path}, which overlaps this source`
      continue
    }
    for (const repository of holds.repositories) {
      const holder = repositories.get(repository)
      if (holder === undefined || index === undefined) {
        repositories.set(repository, row.sourceKey)
        continue
      }
      const holderIndex = yamlIndex.get(holder)
      if (holderIndex !== undefined && index < holderIndex) {
        repositories.set(repository, row.sourceKey)
        skip(holder, repository, row.sourceKey)
      } else skip(row.sourceKey, repository, holder)
    }
    for (const path of holds.paths)
      managed.push({ path, sourceKey: row.sourceKey })
  }
  for (const row of rows) {
    const skipped = skips.get(row.sourceKey)
    if (skipped)
      row.statusDetail = skipped
        .map(
          ({ repository, by }) =>
            `Skips ${repository}: ${by} already links this repository`,
        )
        .join("; ")
  }
}
