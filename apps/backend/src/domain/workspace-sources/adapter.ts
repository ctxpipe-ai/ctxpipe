import type { Env } from "../../config/env.js"
import type { GitFileChange } from "../../services/git/file-change.js"
import { linearSourceAdapter } from "../../services/linear/source-adapter.js"
import type { SourceProvider } from "./sources-file.js"

/**
 * The one interface that a provider implements to sync Workspace sources
 * (ADR-050). The sync frame calls `fetch` one time for each connection with
 * the scopes of all its `ok` sources, then gives each Workspace the fetched
 * files under the `managedPaths` of its own scopes.
 */
export type SourceAdapter<
  S extends Record<string, unknown> = Record<string, unknown>,
> = {
  provider: SourceProvider
  /**
   * The path prefixes (each ends with "/") that one scope owns in a Workspace
   * repository, for example `confluence/ENG/`. Every prefix must be under the
   * provider root (`<provider>/`). The sync replaces these paths and deletes
   * them when the scope goes away.
   */
  managedPaths(scope: S): string[]
  /**
   * Fetch the content of the union of `scopes` one time. Return files at
   * Workspace repository paths. A file belongs to each Workspace whose scope
   * owns its path. An adapter can return a {@link SourceFetchResult} to keep
   * the files of a path it could not read, or to send a patch.
   */
  fetch(input: {
    orgId: string
    connectionId: string
    scopes: readonly S[]
    env: Env
    /** The webhook event of this sync, when a webhook started it. */
    event?: unknown
    /**
     * The managed files that the Workspaces of these scopes have now. A path
     * has a sha only when each Workspace that owns it has the same blob.
     */
    existing?: ReadonlyArray<{ path: string; sha: string | null }>
  }): Promise<GitFileChange[] | SourceFetchResult>
  /** Optional. Tell why a scope is outside the connection's reach, or null. */
  checkAccess?(input: {
    orgId: string
    connectionId: string
    scope: S
    env: Env
  }): Promise<string | null>
  /** Optional. Whether a provider webhook event touches this scope. Default: yes. */
  matchesEvent?(input: { event: unknown; scope: S }): boolean
}

/** A fetch result with more than the files. */
export type SourceFetchResult = {
  files: GitFileChange[]
  /**
   * Path prefixes whose files stay as they are in this cycle: a failed read,
   * or files that did not change.
   */
  keepPaths?: string[]
  /**
   * Managed paths out of the connection's reach for good. The sync keeps
   * their files and sets each source that owns one to this status.
   */
  unreachable?: Array<{
    path: string
    status: "out_of_access" | "invalid"
    detail: string
  }>
  /**
   * A patch: write `files`, delete these paths, and keep each other file
   * under the managed paths. Without it, the managed paths get exactly
   * `files`.
   */
  deletePaths?: string[]
}

/**
 * The adapters in production. Each provider (phase 2) adds its adapter here.
 * A provider without an adapter keeps its sources projected but not synced.
 */
export const SOURCE_ADAPTERS: Partial<Record<SourceProvider, SourceAdapter>> = {
  linear: linearSourceAdapter,
}
