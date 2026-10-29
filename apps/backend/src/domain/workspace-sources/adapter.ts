import type { Env } from "../../config/env.js"
import { buildkiteSourceAdapter } from "../../services/buildkite/workspace-source-adapter.js"
import { confluenceSourceAdapter } from "../../services/confluence/workspace-source-adapter.js"
import type { GitFileChange } from "../../services/git/file-change.js"
import { linearSourceAdapter } from "../../services/linear/source-adapter.js"
import { notionSourceAdapter } from "../../services/notion/workspace-source-adapter.js"
import { pagerdutySourceAdapter } from "../../services/pagerduty/workspace-source-adapter.js"
import { plainSourceAdapter } from "../../services/plain/workspace-source-adapter.js"
import { slackSourceAdapter } from "../../services/slack/source-adapter.js"
import type { SourceProvider } from "./sources-file.js"

/**
 * The one interface that a provider implements to sync Workspace sources
 * (ADR-050). The sync frame calls `fetch` one time for each connection with
 * the scopes of all its `ok` sources, then gives each Workspace the fetched
 * files under the `managedPaths` of its own scopes.
 */
type SourceFetchInput<S> = {
  orgId: string
  connectionId: string
  scopes: readonly S[]
  env: Env
  /** The webhook event of this sync, when a webhook started it. */
  event?: unknown
  /**
   * False for a "Sync now" sync: keep the failure counts as they are. Only
   * scheduled and webhook syncs count toward the bounded tries.
   */
  countFailures: boolean
  /**
   * The managed files that the Workspaces of these scopes have now, when the
   * sync reads them. A path has a sha only when each Workspace that owns it
   * has the same blob.
   */
  existing?: ReadonlyArray<{ path: string; sha: string | null }>
}

/** A provider whose sources sync files. A plain git source syncs none. */
export type MirrorProvider = Exclude<SourceProvider, "git">

export type SourceAdapter<
  S extends Record<string, unknown> = Record<string, unknown>,
> = {
  provider: MirrorProvider
  /**
   * The path prefixes (each ends with "/") that one scope owns in a Workspace
   * repository, for example `confluence/ENG/`. Every prefix must be under the
   * provider root (`<provider>/`). The sync replaces these paths and deletes
   * them when the scope goes away.
   */
  managedPaths(scope: S): string[]
  /**
   * Optional. True when the files cannot be fetched again (captures): a
   * removed or narrowed scope keeps its files, and the cleanup deletes none.
   */
  keepFilesOnRemove?: boolean
  /**
   * Optional. Tell why a scope is outside the connection's reach, or null.
   * `okDetail`: the scope is usable in part; the source stays `ok` and shows
   * the detail.
   */
  checkAccess?(input: {
    orgId: string
    connectionId: string
    scope: S
    env: Env
  }): Promise<string | { okDetail: string } | null>
  /** Optional. Whether a provider webhook event touches this scope. Default: yes. */
  matchesEvent?(input: { event: unknown; scope: S }): boolean
  /**
   * Optional. A sync problem of an `ok` source, for example a page that
   * failed too many times. The source list shows it at read time.
   */
  syncStatus?(input: {
    orgId: string
    connectionId: string
    scope: S
  }): Promise<{ status: "invalid" | "out_of_access"; detail: string } | null>
  /**
   * Fetch the content of the union of `scopes` one time. Return files at
   * Workspace repository paths. A file belongs to each Workspace whose scope
   * owns its path. A {@link SourceFetchResult} can also keep the files of a
   * path it could not read, report a path out of reach, send a patch, or
   * give the files of each scope.
   */
  fetch(
    input: SourceFetchInput<S>,
  ): Promise<GitFileChange[] | SourceFetchResult>
}

/** A fetch result with more than the files. */
export type SourceFetchResult = (
  | { files: GitFileChange[] }
  | {
      /**
       * Use this instead of `files` when the file layout of a scope depends
       * on the full scope, not only on its paths (for example, the
       * Confluence page tree of a page selection). The files of each scope,
       * in the order of `scopes`. A Workspace gets the files of its own
       * scopes. `null` for a scope skips the write of each Workspace that
       * has it, so its last good copy stays.
       */
      filesByScope: Array<GitFileChange[] | null>
    }
) & {
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
  confluence: confluenceSourceAdapter,
  linear: linearSourceAdapter,
  notion: notionSourceAdapter as SourceAdapter,
  pagerduty: pagerdutySourceAdapter as SourceAdapter,
  plain: plainSourceAdapter as SourceAdapter,
  slack: slackSourceAdapter,
  buildkite: buildkiteSourceAdapter as SourceAdapter,
}
