import type { Env } from "../../config/env.js"
import { confluenceSourceMigrationHook } from "../../services/confluence/workspace-source-migration.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../workspaces/write-status.js"
import type { SourceChange } from "./edit.js"
import {
  parseSourceEntry,
  type SourceProvider,
  sourcesFileSchema,
} from "./sources-file.js"
import { parseSourcesYaml } from "./sources-yaml.js"

/** What one existing connection syncs today, read from its config (ADR-050 migration). */
export type LegacySourceBinding =
  | {
      provider: SourceProvider
      connectionId: string
      /** The connection's old sync repository. */
      syncRepositoryUrl: string
      scope: Record<string, unknown>
    }
  | {
      provider: SourceProvider
      connectionId: string
      /** Why this connection's config does not map to a source entry. */
      unmapped: string
    }

/**
 * The one migration hook for each provider (phase 2 adds them): turn the
 * existing connections of an org into source bindings.
 */
export type SourceMigrationHook = {
  provider: SourceProvider
  listLegacyBindings(input: {
    orgId: string
    env: Env
  }): Promise<LegacySourceBinding[]>
  /**
   * Optional. Turn off the legacy sync of a migrated connection, so only the
   * Workspace sources sync writes its content (`--apply`).
   */
  disableLegacy?(input: { orgId: string; connectionId: string }): Promise<void>
}

export const SOURCE_MIGRATION_HOOKS: Partial<
  Record<SourceProvider, SourceMigrationHook>
> = {
  confluence: confluenceSourceMigrationHook,
}

export type MigrationWorkspace = {
  id: string
  workspaceRepositoryUrl: string
  githubConnectionId: string | null
  /** The current `.ctxpipe/sources.yaml`, or null when absent. */
  sourcesFile: string | null
}

export type SourceMigrationReport = {
  moved: Array<{
    workspaceId: string
    provider: SourceProvider
    connectionId: string
  }>
  alreadyPresent: Array<{
    workspaceId: string
    provider: SourceProvider
    connectionId: string
  }>
  unmapped: Array<{
    provider: SourceProvider
    connectionId: string | null
    workspaceId: string | null
    reason: string
  }>
}

function existingPairs(text: string | null): Set<string> {
  if (!text) return new Set()
  try {
    const file = sourcesFileSchema.safeParse(parseSourcesYaml(text))
    if (!file.success) return new Set()
    return new Set(
      file.data.sources.flatMap((raw) => {
        const parsed = parseSourceEntry(raw)
        return parsed.ok
          ? [`${parsed.entry.provider}:${parsed.entry.connectionId}`]
          : []
      }),
    )
  } catch {
    return new Set()
  }
}

/**
 * Plan the migration of an org: for each Workspace, the source entries to add
 * to its `.ctxpipe/sources.yaml`. A connection maps to each Workspace whose
 * own repository or linked repositories include its old sync repository.
 * GitHub linked repositories become one GitHub source of the Workspace.
 * Running the plan again after the PRs merge adds nothing.
 */
export function planSourceMigration(input: {
  workspaces: readonly MigrationWorkspace[]
  linked: ReadonlyArray<{ workspaceId: string; gitUrl: string }>
  bindings: readonly LegacySourceBinding[]
}): {
  changes: Map<string, SourceChange[]>
  report: SourceMigrationReport
} {
  const report: SourceMigrationReport = {
    moved: [],
    alreadyPresent: [],
    unmapped: [],
  }
  const changes = new Map<string, SourceChange[]>()
  const present = new Map(
    input.workspaces.map((workspace) => [
      workspace.id,
      existingPairs(workspace.sourcesFile),
    ]),
  )
  const add = (
    workspaceId: string,
    change: Extract<SourceChange, { action: "add" }>,
  ) => {
    const pair = `${change.provider}:${change.connectionId}`
    const item = {
      workspaceId,
      provider: change.provider,
      connectionId: change.connectionId,
    }
    if (present.get(workspaceId)?.has(pair)) {
      report.alreadyPresent.push(item)
      return
    }
    present.get(workspaceId)?.add(pair)
    changes.set(workspaceId, [...(changes.get(workspaceId) ?? []), change])
    report.moved.push(item)
  }

  const linkedByWorkspace = new Map<string, string[]>()
  for (const link of input.linked)
    linkedByWorkspace.set(link.workspaceId, [
      ...(linkedByWorkspace.get(link.workspaceId) ?? []),
      normalizeWorkspaceRepositoryUrl(link.gitUrl),
    ])

  for (const binding of input.bindings) {
    if ("unmapped" in binding) {
      report.unmapped.push({
        provider: binding.provider,
        connectionId: binding.connectionId,
        workspaceId: null,
        reason: binding.unmapped,
      })
      continue
    }
    const target = normalizeWorkspaceRepositoryUrl(binding.syncRepositoryUrl)
    const workspaces = input.workspaces.filter(
      (workspace) =>
        normalizeWorkspaceRepositoryUrl(workspace.workspaceRepositoryUrl) ===
          target || linkedByWorkspace.get(workspace.id)?.includes(target),
    )
    if (!workspaces.length) {
      report.unmapped.push({
        provider: binding.provider,
        connectionId: binding.connectionId,
        workspaceId: null,
        reason: "No Workspace uses or links the old sync repository",
      })
      continue
    }
    for (const workspace of workspaces)
      add(workspace.id, {
        action: "add",
        provider: binding.provider,
        connectionId: binding.connectionId,
        scope: binding.scope,
      })
  }

  for (const workspace of input.workspaces) {
    const repositories = (linkedByWorkspace.get(workspace.id) ?? []).flatMap(
      (url) => githubRepoFullNameFromWorkspaceUrl(url) ?? [],
    )
    if (!repositories.length) continue
    if (!workspace.githubConnectionId) {
      report.unmapped.push({
        provider: "github",
        connectionId: null,
        workspaceId: workspace.id,
        reason:
          "The Workspace links GitHub repositories but has no GitHub connection",
      })
      continue
    }
    add(workspace.id, {
      action: "add",
      sourceKey: "linked-repositories",
      provider: "github",
      connectionId: workspace.githubConnectionId,
      scope: { repositories: [...new Set(repositories)].sort() },
    })
  }
  return { changes, report }
}
