import type { Env } from "../../config/env.js"
import type { GitFileChange } from "../../services/git/file-change.js"
import { githubSourceAdapter } from "./adapters/github.js"
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
   * owns its path.
   */
  fetch(input: {
    orgId: string
    connectionId: string
    scopes: readonly S[]
    env: Env
  }): Promise<GitFileChange[]>
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

/**
 * The adapters in production. Each provider (phase 2) adds its adapter here.
 * A provider without an adapter keeps its sources projected but not synced.
 */
export const SOURCE_ADAPTERS: Partial<Record<SourceProvider, SourceAdapter>> = {
  github: githubSourceAdapter,
}
