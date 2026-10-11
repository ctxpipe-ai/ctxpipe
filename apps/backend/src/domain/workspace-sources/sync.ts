import type { Env } from "../../config/env.js"
import {
  listConnectionSourceRows,
  listWorkspaceSourceRows,
} from "../../models/workspace-sources.js"
import type { GitFileChange } from "../../services/git/file-change.js"
import type { SourceAdapter } from "./adapter.js"
import type { SourceProvider } from "./sources-file.js"

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
   * The Workspace revision of the source rows that planned this write. The
   * writer drops the write when the sources file changed after it.
   */
  sourcesRevision: string
}

export type SliceWriter = (write: WorkspaceSliceWrite) => Promise<void>

function underAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix))
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
    { prefixes: Set<string>; revision: string }
  >()
  for (const row of rows) {
    const prefixes = adapter.managedPaths(row.scope)
    assertManagedPaths(adapter, prefixes)
    const entry = byWorkspace.get(row.workspaceId) ?? {
      prefixes: new Set<string>(),
      revision: row.revision,
    }
    for (const prefix of prefixes) entry.prefixes.add(prefix)
    byWorkspace.set(row.workspaceId, entry)
  }

  // A provider that owns no path (GitHub) has nothing to write.
  if (![...byWorkspace.values()].some((entry) => entry.prefixes.size))
    return { fetchedScopes: 0, workspaces: [] }

  const scopes = [
    ...new Map(
      rows.map((row) => [JSON.stringify(row.scope), row.scope]),
    ).values(),
  ]
  const fetched = await adapter.fetch({
    orgId: input.orgId,
    connectionId: input.connectionId,
    scopes,
    env: input.env,
  })
  for (const [workspaceId, entry] of byWorkspace) {
    const ownedPrefixes = [...entry.prefixes].sort()
    await input.write({
      orgId: input.orgId,
      workspaceId,
      provider: adapter.provider,
      connectionId: input.connectionId,
      files: fetched.filter((file) => underAny(file.path, ownedPrefixes)),
      ownedPrefixes,
      keepPrefixes: [],
      sourcesRevision: entry.revision,
    })
  }
  return { fetchedScopes: scopes.length, workspaces: [...byWorkspace.keys()] }
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
    if (!adapter || !source.connectionId) continue
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
