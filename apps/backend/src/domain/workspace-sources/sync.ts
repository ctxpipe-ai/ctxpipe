import type { Env } from "../../config/env.js"
import {
  listConnectionSourceRows,
  listWorkspaceSourceRows,
  setWorkspaceSourceStatus,
} from "../../models/workspace-sources.js"
import type { GitFileChange } from "../../services/git/file-change.js"
import type { SourceAdapter, SourceFetchResult } from "./adapter.js"
import { checkSourcePath } from "./source-file.js"
import type { SourceProvider } from "./sources-file.js"
import { stampSources } from "./stamp-sources.js"

/**
 * One commit for one Workspace in one sync cycle. Files under
 * `ownedPrefixes` that are not in `files` are deleted, except files under
 * `keepPrefixes`, which another source still owns.
 */
export type WorkspaceSliceWrite = {
  orgId: string
  workspaceId: string
  provider: SourceProvider
  connectionId: string
  files: GitFileChange[]
  ownedPrefixes: string[]
  keepPrefixes: string[]
  /**
   * A patch: delete only these paths and keep each other file. Without it,
   * the owned paths get exactly `files`.
   */
  deletePaths?: string[]
  /**
   * The Workspace revision of the source rows that planned this write. The
   * writer drops the write when the sources file changed after it.
   */
  sourcesRevision: string
}

export type SliceWriter = (write: WorkspaceSliceWrite) => Promise<void>

function underAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix))
}

/**
 * One blob of a Workspace head. `sources` and `unstampedSha` are set when the
 * reader looked at the `sources` front matter of a Markdown file: `sources`
 * is its list (null when it has none), `unstampedSha` the blob id of the text
 * without the list.
 */
export type ExistingBlob = {
  path: string
  sha: string
  sources?: string[] | null
  unstampedSha?: string
}

/** The source path of a row, or null when its key is not a source path. */
function sourcePathOf(sourceKey: string): string | null {
  return checkSourcePath(sourceKey).ok ? sourceKey : null
}

/** The source path of the row that owns `path`, or null. */
function ownerOf(
  owners: ReadonlyArray<{ path: string; prefixes: readonly string[] }>,
  path: string,
): string | null {
  return owners.find((owner) => underAny(path, owner.prefixes))?.path ?? null
}

function overlaps(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a)
}

function assertManagedPaths(adapter: SourceAdapter, prefixes: string[]) {
  for (const prefix of prefixes) {
    const parts = prefix.slice(0, -1).split("/")
    if (
      !prefix.startsWith(`${adapter.provider}/`) ||
      !prefix.endsWith("/") ||
      prefix.includes("\\") ||
      parts.some((part) => part === "" || part === "." || part === "..")
    )
      throw new Error(
        `Managed path "${prefix}" must be a relative path under ${adapter.provider}/ that ends with "/"`,
      )
  }
}

/**
 * Sync one connection: fetch the union of its `ok` source scopes one time,
 * then write each Workspace's slice in one commit. With `event`, only the
 * sources whose scope matches the event sync (webhook fan-out).
 */
export async function syncConnectionSources(input: {
  orgId: string
  connectionId: string
  env: Env
  adapter: SourceAdapter
  write: SliceWriter
  event?: unknown
  /**
   * A "Sync now" sync. Its failures do not count toward the bounded tries,
   * so that repeated clicks cannot mark a root out of reach.
   */
  manual?: boolean
  /** The blobs of one Workspace now, so that the adapter can skip unchanged files. */
  readExisting?: (workspaceId: string) => Promise<ReadonlyArray<ExistingBlob>>
}): Promise<{ fetchedScopes: number; workspaces: string[] }> {
  const { adapter } = input
  const rows = (
    await listConnectionSourceRows({
      orgId: input.orgId,
      connectionId: input.connectionId,
      status: "ok",
    })
  )
    .map((row) => row.source)
    .filter((row) => row.provider === adapter.provider)
    .filter(
      (row) =>
        input.event === undefined ||
        (adapter.matchesEvent?.({ event: input.event, scope: row.scope }) ??
          true),
    )
  if (!rows.length) return { fetchedScopes: 0, workspaces: [] }

  // Check every managed path before the provider fetch.
  const byWorkspace = new Map<
    string,
    {
      prefixes: Set<string>
      scopeKeys: Set<string>
      revision: string
      /** The source paths of the rows, with their managed paths. */
      owners: Array<{ path: string; prefixes: string[] }>
    }
  >()
  for (const row of rows) {
    const prefixes = adapter.managedPaths(row.scope)
    assertManagedPaths(adapter, prefixes)
    const entry = byWorkspace.get(row.workspaceId) ?? {
      prefixes: new Set<string>(),
      scopeKeys: new Set<string>(),
      revision: row.revision,
      owners: [],
    }
    const sourcePath = sourcePathOf(row.sourceKey)
    if (sourcePath) entry.owners.push({ path: sourcePath, prefixes })
    for (const prefix of prefixes) entry.prefixes.add(prefix)
    entry.scopeKeys.add(JSON.stringify(row.scope))
    byWorkspace.set(row.workspaceId, entry)
  }

  const scopesByKey = new Map(
    rows.map((row) => [JSON.stringify(row.scope), row.scope]),
  )
  const scopes = [...scopesByKey.values()]
  const fetchInput = {
    orgId: input.orgId,
    connectionId: input.connectionId,
    scopes,
    env: input.env,
    event: input.event,
    countFailures: !input.manual,
    existing: input.readExisting
      ? await readExistingManaged(byWorkspace, input.readExisting)
      : undefined,
  }
  const fetched = await adapter.fetch(fetchInput)
  const result: SourceFetchResult = Array.isArray(fetched)
    ? { files: fetched }
    : fetched
  // With `filesByScope`, a Workspace gets only the files of its own scopes,
  // and a failed scope (null) skips the write of each Workspace that has it.
  const byKey = new Map(
    "filesByScope" in result
      ? [...scopesByKey.keys()].map((key, index) => [
          key,
          result.filesByScope[index],
        ])
      : [],
  )
  const filesOf = (scopeKeys: Set<string>): GitFileChange[] | null => {
    if ("files" in result) return result.files
    const lists = [...scopeKeys].map((key) => byKey.get(key))
    if (lists.some((list) => !list)) return null
    return [
      ...new Map(
        lists.flatMap((list) => list ?? []).map((file) => [file.path, file]),
      ).values(),
    ]
  }
  const unreachable = result.unreachable ?? []
  for (const lost of unreachable)
    for (const row of rows)
      if (adapter.managedPaths(row.scope).includes(lost.path))
        await setWorkspaceSourceStatus({
          orgId: input.orgId,
          id: row.id,
          status: lost.status,
          statusDetail: lost.detail,
        })
  const kept = [
    ...(result.keepPaths ?? []),
    ...unreachable.map((lost) => lost.path),
  ]
  const written: string[] = []
  for (const [workspaceId, entry] of byWorkspace) {
    const all = filesOf(entry.scopeKeys)
    if (!all) continue
    const ownedPrefixes = [...entry.prefixes].sort()
    const keepPrefixes = kept
      .filter((path) => underAny(path, ownedPrefixes))
      .sort()
    const files = all
      .filter((file) => underAny(file.path, ownedPrefixes))
      .map((file) => stampFile(file, ownerOf(entry.owners, file.path)))
    const deletePaths = result.deletePaths?.filter(
      (path) => underAny(path, ownedPrefixes) && !underAny(path, keepPrefixes),
    )
    const allKept = ownedPrefixes.every((prefix) =>
      keepPrefixes.includes(prefix),
    )
    if (allKept && !files.length) continue
    if (deletePaths && !files.length && !deletePaths.length) continue
    await input.write({
      orgId: input.orgId,
      workspaceId,
      provider: adapter.provider,
      connectionId: input.connectionId,
      files,
      ownedPrefixes,
      keepPrefixes,
      ...(deletePaths ? { deletePaths } : {}),
      sourcesRevision: entry.revision,
    })
    written.push(workspaceId)
  }
  return { fetchedScopes: scopes.length, workspaces: written }
}

/**
 * Add the `sources` front matter (ADR-050) to a Markdown file of a mirror.
 * A file with no front matter, or with no source path, stays as it is.
 */
function stampFile(file: GitFileChange, sourcePath: string | null) {
  if (!sourcePath || !file.path.endsWith(".md") || file.encoding === "base64")
    return file
  return { ...file, content: stampSources(file.content, [sourcePath]) }
}

/**
 * The managed files of the Workspaces. A path has its sha only when each
 * Workspace that owns the path has the same blob there. The sha of a
 * Markdown file is the one of the text that the adapter wrote, without the
 * `sources` list. A file with a wrong or missing list has no sha, so the
 * adapter writes it again and the sync stamps it.
 */
async function readExistingManaged(
  byWorkspace: ReadonlyMap<
    string,
    {
      prefixes: Set<string>
      owners: ReadonlyArray<{ path: string; prefixes: readonly string[] }>
    }
  >,
  read: (workspaceId: string) => Promise<ReadonlyArray<ExistingBlob>>,
): Promise<Array<{ path: string; sha: string | null }>> {
  const shas = new Map<string, string | null>()
  const seen = new Map<string, number>()
  const trees: string[][] = []
  for (const [workspaceId, entry] of byWorkspace) {
    const prefixes = [...entry.prefixes]
    trees.push(prefixes)
    for (const blob of await read(workspaceId)) {
      if (!underAny(blob.path, prefixes)) continue
      seen.set(blob.path, (seen.get(blob.path) ?? 0) + 1)
      const sha = adapterSha(blob, ownerOf(entry.owners, blob.path))
      const before = shas.get(blob.path)
      shas.set(blob.path, before === undefined || before === sha ? sha : null)
    }
  }
  return [...shas].map(([path, sha]) => ({
    path,
    sha:
      seen.get(path) ===
      trees.filter((prefixes) => underAny(path, prefixes)).length
        ? sha
        : null,
  }))
}

function adapterSha(blob: ExistingBlob, owner: string | null): string | null {
  // The reader did not look at the front matter: the sha is as it is.
  if (blob.sources === undefined || !blob.path.endsWith(".md")) return blob.sha
  if (!owner) return blob.unstampedSha ?? blob.sha
  const stamped =
    blob.sources?.length === 1 && blob.sources[0] === owner
      ? blob.unstampedSha
      : undefined
  return stamped ?? null
}

/**
 * Delete the managed files of removed or narrowed sources in one commit for
 * each provider. Paths that another `ok` source of the Workspace still owns
 * stay.
 */
export async function cleanupRemovedSources(input: {
  orgId: string
  workspaceId: string
  /** The Workspace revision whose projection removed the sources. */
  revision: string
  removed: ReadonlyArray<{
    provider: string | null
    connectionId: string | null
    scope: Record<string, unknown>
  }>
  adapters: Partial<Record<SourceProvider, SourceAdapter>>
  write: SliceWriter
}): Promise<WorkspaceSliceWrite[]> {
  const remaining = (
    await listWorkspaceSourceRows({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
    })
  ).filter((row) => row.status === "ok")
  const writes: WorkspaceSliceWrite[] = []
  const byProvider = new Map<
    SourceProvider,
    { connectionId: string; prefixes: Set<string>; keep: Set<string> }
  >()
  for (const source of input.removed) {
    const adapter = source.provider
      ? input.adapters[source.provider as SourceProvider]
      : undefined
    if (!adapter || adapter.keepFilesOnRemove || !source.connectionId) continue
    const kept = remaining
      .filter((row) => row.provider === adapter.provider)
      .flatMap((row) => adapter.managedPaths(row.scope))
    assertManagedPaths(adapter, kept)
    const removedPaths = adapter.managedPaths(source.scope)
    assertManagedPaths(adapter, removedPaths)
    // A path inside a kept path stays; a wider path keeps the kept files.
    const stale = removedPaths.filter((prefix) => !underAny(prefix, kept))
    if (!stale.length) continue
    const entry = byProvider.get(adapter.provider) ?? {
      connectionId: source.connectionId,
      prefixes: new Set<string>(),
      keep: new Set<string>(),
    }
    for (const prefix of stale) {
      entry.prefixes.add(prefix)
      for (const keep of kept) if (overlaps(prefix, keep)) entry.keep.add(keep)
    }
    byProvider.set(adapter.provider, entry)
  }
  for (const [provider, entry] of byProvider) {
    const write: WorkspaceSliceWrite = {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      provider,
      connectionId: entry.connectionId,
      files: [],
      ownedPrefixes: [...entry.prefixes].sort(),
      keepPrefixes: [...entry.keep].sort(),
      sourcesRevision: input.revision,
    }
    await input.write(write)
    writes.push(write)
  }
  return writes
}
